import { env } from "cloudflare:workers";
import {
  type CartLine, type Config, type Item, type Metrics, type Order,
  type Product, type PublishedSubmission, type Slot, type Stage, type Submission,
  dateKey, defaultConfig, extrasFor, originalProducts, payments, slotMs, students, time, zone,
} from "./federal";

type StoredOrder = Omit<Order, "demo" | "tracking" | "code" | "items" | "events"> & {
  tracking: string;
  code: string;
  request_key: string;
  request_hash: string | null;
  items: string;
  events: string;
};

export class Problem extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function readBoundedBody(request: Request, limit: number, message: string) {
  if (Number(request.headers.get("content-length")) > limit) throw new Problem(413, message);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Problem(413, message);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function database() {
  if (!env.DB) throw new Problem(503, "A base de pedidos está indisponível. Tente novamente em instantes.");
  return env.DB;
}

export function isOperator(headers: Headers) {
  const email = headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  const permitted = (env.FEDERAL_OPERATORS ?? "").toLowerCase().split(/[;,\n]/).map(entry => entry.trim()).filter(Boolean);
  // Sites dispatch supplies the authenticated headers. The Worker has no public origin of its own.
  return Boolean(headers.get("oai-authenticated-user-id")?.trim() && email && permitted.includes(email));
}

export async function storeContext() {
  const db = database();
  const [ops, catalog] = await db.batch([
    db.prepare("SELECT config, revision FROM operation WHERE id=1"),
    db.prepare("SELECT id, changes FROM product_overrides"),
  ]);
  const row = ops.results[0] as { config: string; revision: number } | undefined;
  const productRows = catalog.results as { id: string; changes: string }[];
  const changes = new Map(productRows.map(row => [row.id, JSON.parse(row.changes)]));
  const products = originalProducts.map(product => ({ ...product, ...changes.get(product.id) })) as Product[];
  return { config: row ? JSON.parse(row.config) as Config : defaultConfig, revision: row?.revision ?? 0, products };
}

async function ensureConfig() {
  await database().prepare("INSERT OR IGNORE INTO operation (id, revision, config) VALUES (1, 0, ?)").bind(JSON.stringify(defaultConfig)).run();
}

function textField(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validateSlotTime(value: string) {
  return /^([01]\d|2[0-3]):(00|15|30|45)$/.test(value) || value === "24:00";
}

const occupancyWhere = "(payment='aprovado' OR (payment='pendente' AND expires_at > ?))";
const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" });
const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function slotCapacity(config: Config, start: number) {
  const date = dateKey(start);
  const hour = time(start);
  const weekday = dayIndex.indexOf(dayOfWeek.format(start));
  const schedule = config.hours[weekday];
  if (!schedule?.open || hour < schedule.start || hour >= schedule.end) return 0;
  const adjustment = config.overrides.findLast(x => x.date === date && x.start <= hour && hour < x.end);
  return adjustment?.capacity ?? config.capacity;
}

export async function upcomingSlots(config: Config, now = Date.now()) {
  if (config.paused) return [];
  const first = Math.ceil((now + 10 * 60_000) / slotMs) * slotMs;
  const end = first + 7 * 24 * 60 * 60_000;
  const records = await database().prepare(`SELECT slot, COUNT(*) as count FROM orders WHERE slot >= ? AND slot < ? AND ${occupancyWhere} GROUP BY slot`)
    .bind(first, end, now).all<{ slot: number; count: number }>();
  const counts = new Map(records.results.map(row => [row.slot, row.count]));
  const slots: Slot[] = [];
  for (let start = first; start < end; start += slotMs) {
    const capacity = slotCapacity(config, start);
    if (!capacity) continue;
    slots.push({ start, remaining: Math.max(0, capacity - (counts.get(start) ?? 0)), capacity });
  }
  return slots;
}

function orderView(row: StoredOrder, operator = false): Order {
  const { items, tracking, code, events, campaign, request_key: _requestKey, request_hash: _requestHash, ...rest } = row;
  const order: Order = { ...rest, demo: true, items: JSON.parse(items) };
  if (operator) return { ...order, campaign, events: JSON.parse(events) };
  return { ...order, tracking, ...(row.payment === "aprovado" && row.stage !== "retirado" ? { code } : {}) };
}

const randomToken = () => crypto.randomUUID().replaceAll("-", "");
function pickupCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), value => alphabet[value & 31]).join("");
}

function makeItems(raw: unknown, products: Product[]) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) throw new Problem(400, "Adicione um item à sacola.");
  return raw.map((line: CartLine): Item => {
    const product = products.find(p => p.id === line?.product);
    if (!product) throw new Problem(400, "Há um item desconhecido na sacola.");
    if (product.disponivel === false) throw new Problem(409, `${product.nome} está esgotado na demonstração.`);
    const variant = product.variantes.find(v => v.id === line.variant);
    if ((product.variantes.length > 0 && !variant) || (!product.variantes.length && line.variant)) {
      throw new Problem(400, `Confira a versão de ${product.nome}.`);
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 15) throw new Problem(400, "Use uma quantidade de 1 a 15 por item.");
    const press = product.categoria === "dogoes" ? line.press : "";
    if (product.categoria === "dogoes" && !["Prensado", "Sem prensar"].includes(press)) throw new Problem(400, "Escolha o preparo do dogão.");
    const allowed = extrasFor(product, products);
    if (!Array.isArray(line.extras) || line.extras.length > 8 || new Set(line.extras).size !== line.extras.length) throw new Problem(400, "Confira os complementos da sacola.");
    const extras = line.extras.map(id => {
      const extra = allowed.find(p => p.id === id && p.disponivel !== false);
      if (!extra) throw new Problem(409, "Um complemento está indisponível. Edite o item para continuar.");
      return { name: extra.nome, price: extra.preco_centavos };
    });
    const unit = (variant?.preco_centavos ?? product.preco_centavos) + extras.reduce((total, extra) => total + extra.price, 0);
    return { product: product.id, name: product.nome, variant: variant?.rotulo ?? "", press, extras, quantity: line.quantity, note: textField(line.note, 180), unit, total: unit * line.quantity };
  });
}

async function expireOrders(now: number, token?: string) {
  const sql = `UPDATE orders SET payment='expirado', stage='cancelado', events=json_insert(events, '$[#]', json(?))
    WHERE payment='pendente' AND expires_at <= ?${token ? " AND tracking=?" : ""}`;
  const values = [JSON.stringify({ label: "Reserva expirada", at: now }), now, ...(token ? [token] : [])];
  await database().prepare(sql).bind(...values).run();
}

export async function createOrder(body: Record<string, unknown>) {
  const db = database();
  const requestKey = textField(body.requestKey, 80).toLowerCase();
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(requestKey)) {
    throw new Problem(400, "Abra novamente o checkout para continuar.");
  }
  const customer = textField(body.customer, 60);
  if (customer.length < 2) throw new Problem(400, "Informe um nome ou apelido para a retirada.");
  const method = body.method;
  if (method !== "Pix" && method !== "Cartão") throw new Problem(400, "Escolha Pix ou cartão para simular.");
  const payment = body.scenario;
  if (payment !== "aprovado" && payment !== "pendente" && payment !== "recusado" && payment !== "expirado") throw new Problem(400, "Escolha um resultado para simular.");
  const pickup = body.pickup;
  if (pickup !== "imediata" && pickup !== "agendada") throw new Problem(400, "Escolha uma modalidade de retirada.");
  const requestedSlot = pickup === "agendada" ? body.slot : null;
  if (pickup === "agendada" && (typeof requestedSlot !== "number" || !Number.isSafeInteger(requestedSlot) || requestedSlot % slotMs !== 0)) {
    throw new Problem(400, "Escolha uma janela válida de 15 minutos.");
  }
  if (!Number.isSafeInteger(body.total) || (body.total as number) < 0) throw new Problem(400, "Confira o valor do pedido.");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) throw new Problem(400, "Use de 1 a 30 itens na sacola.");
  const campaign = textField(body.campaign, 64).replace(/[^a-z0-9_-]/gi, "") || null;
  const lines = body.items.map((line: CartLine) => [
    line?.product, line?.variant, line?.press, line?.extras, line?.quantity, textField(line?.note, 180),
  ]);
  const payload = JSON.stringify([customer, method, payment, pickup, requestedSlot, body.total, campaign, lines]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const requestHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  function checkReplay(row: StoredOrder) {
    if (row.request_hash === null) {
      // Orders from before the hash migration are still accessible by their tracking links.
      throw new Problem(409, "Este envio já foi registrado. Consulte a confirmação em Meus pedidos.");
    }
    if (row.request_hash !== requestHash) throw new Problem(409, "Este envio já foi usado com outros dados. Confira a sacola.");
    return getOrder(row.tracking);
  }
  const findRequest = db.prepare("SELECT * FROM orders WHERE request_key=?").bind(requestKey);
  const repeated = await findRequest.first<StoredOrder>();
  if (repeated) return checkReplay(repeated);

  await ensureConfig();
  const { config, revision, products } = await storeContext();
  if (config.paused) throw new Problem(409, "A Kombi pausou novos pedidos.");
  const items = makeItems(body.items, products);
  const total = items.reduce((sum, item) => sum + item.total, 0);
  if (body.total !== total) throw new Problem(409, "O preço do cardápio mudou. Confira o valor atualizado antes de continuar.");
  const now = Date.now();
  const available = await upcomingSlots(config, now);
  const slot = pickup === "imediata"
    ? available.find(x => x.remaining > 0)
    : available.find(x => x.start === body.slot && x.remaining > 0);
  if (!slot) {
    const recorded = await findRequest.first<StoredOrder>();
    if (recorded) return checkReplay(recorded);
    throw new Problem(409, "Essa janela está indisponível. Escolha outro horário.");
  }
  const id = crypto.randomUUID();
  const tracking = randomToken();
  const code = pickupCode();
  const expiresAt = payment === "pendente" ? now + 5 * 60_000 : null;
  const stage: Stage = payment === "recusado" || payment === "expirado" ? "cancelado" : "recebido";
  const events = JSON.stringify([{ label: `Pagamento demonstrativo · ${payments[payment]}`, at: now }]);
  // D1 executes the capacity check and the insert in a single SQLite statement.
  await db.prepare(`INSERT INTO orders
    (id, tracking, request_key, request_hash, code, customer, slot, pickup, items, total, method, payment, stage, campaign, created_at, expires_at, events)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT revision FROM operation WHERE id=1) = ?
      AND (SELECT COUNT(*) FROM orders WHERE slot=? AND ${occupancyWhere}) < ?
    ON CONFLICT(request_key) DO NOTHING`)
    .bind(id, tracking, requestKey, requestHash, code, customer, slot.start, pickup, JSON.stringify(items), total, method, payment, stage, campaign, now, expiresAt, events, revision, slot.start, now, slot.capacity).run();
  const row = await findRequest.first<StoredOrder>();
  if (!row) throw new Problem(409, "A operação mudou ou a última vaga foi ocupada. Confira os horários e tente novamente.");
  return row.id === id ? orderView(row) : checkReplay(row);
}

export async function getOrder(token: string) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Problem(404, "Pedido não encontrado. Confira o link de acompanhamento.");
  const statement = database().prepare("SELECT * FROM orders WHERE tracking=?").bind(token);
  const row = await statement.first<StoredOrder>();
  if (!row) throw new Problem(404, "Pedido não encontrado. Confira o link de acompanhamento.");
  const now = Date.now();
  if (row.payment === "pendente" && row.expires_at !== null && row.expires_at <= now) {
    await expireOrders(now, token);
    const current = await statement.first<StoredOrder>();
    if (current) return orderView(current);
  }
  return orderView(row);
}

export async function resolvePayment(token: string, action: unknown) {
  const order = await getOrder(token);
  if (action !== "aprovado" && action !== "recusado" && action !== "expirado") throw new Problem(400, "Resultado inválido.");
  if (order.payment !== "pendente") throw new Problem(409, "O pagamento de teste já foi resolvido.");
  const now = Date.now();
  const update = await database().prepare(`UPDATE orders SET payment=?, stage=?, expires_at=NULL,
    events=json_insert(events,'$[#]',json(?)) WHERE tracking=? AND payment='pendente' AND expires_at > ?`)
    .bind(action, action === "aprovado" ? "recebido" : "cancelado", JSON.stringify({ label: `Pagamento demonstrativo · ${payments[action]}`, at: now }), token, now).run();
  if (!update.meta.changes) throw new Problem(409, "A reserva mudou. Atualize o acompanhamento.");
  return getOrder(token);
}

export async function moveOrder(id: string, action: unknown, inputCode: unknown) {
  const db = database();
  await expireOrders(Date.now());
  const row = await db.prepare("SELECT * FROM orders WHERE id=?").bind(id).first<StoredOrder>();
  if (!row) throw new Problem(404, "Pedido não encontrado.");
  const now = Date.now();
  let next: Stage;
  let payment = row.payment;
  let label: string;
  if (action === "start" && row.stage === "recebido" && payment === "aprovado") {
    next = "em_preparo"; label = "Preparo iniciado";
  } else if (action === "ready" && row.stage === "em_preparo" && payment === "aprovado") {
    next = "pronto"; label = "Pedido pronto";
  } else if (action === "pickup" && row.stage === "pronto" && payment === "aprovado") {
    if (textField(inputCode, 8).toUpperCase() !== row.code) throw new Problem(400, "Código incorreto. Confira o código mostrado ao cliente.");
    next = "retirado"; label = "Retirada confirmada por código";
  } else if (action === "cancel" && ["recebido", "em_preparo", "pronto"].includes(row.stage) && ["aprovado", "pendente"].includes(payment)) {
    next = "cancelado";
    payment = payment === "aprovado" ? "reembolsado" : "expirado";
    label = payment === "reembolsado" ? "Pedido cancelado e reembolso simulado" : "Pedido cancelado e reserva liberada";
  } else {
    throw new Problem(409, "Essa ação não está disponível no estado atual do pedido.");
  }
  const result = await db.prepare(`UPDATE orders SET stage=?, payment=?,
    started_at=COALESCE(?, started_at), ready_at=COALESCE(?, ready_at), picked_at=COALESCE(?, picked_at),
    expires_at=NULL, events=json_insert(events,'$[#]',json(?)) WHERE id=? AND stage=? AND payment=?`)
    .bind(next, payment, action === "start" ? now : null, action === "ready" ? now : null, action === "pickup" ? now : null,
      JSON.stringify({ label, at: now }), id, row.stage, row.payment).run();
  if (!result.meta.changes) throw new Problem(409, "O pedido mudou. Atualize a fila.");
  return { ok: true };
}

function metricsFrom(rows: Order[], config: Config, occupancyRows: { slot: number; count: number }[]): Metrics {
  const approved = rows.filter(r => r.payment === "aprovado");
  const value = approved.reduce((sum, r) => sum + r.total, 0);
  const cooked = rows.filter(r => r.ready_at !== null && r.started_at !== null);
  const prepMinutes = cooked.length ? cooked.reduce((sum, r) => sum + (r.ready_at! - r.started_at!) / 60_000, 0) / cooked.length : null;
  const top = new Map<string, number>();
  for (const order of approved) for (const item of order.items) top.set(item.name, (top.get(item.name) ?? 0) + item.quantity);
  return {
    count: rows.length, approved: approved.length, value, average: approved.length ? Math.round(value / approved.length) : 0, prepMinutes,
    top: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, quantity]) => ({ name, quantity })),
    occupancy: occupancyRows.map(x => ({ start: x.slot, count: x.count, capacity: slotCapacity(config, x.slot) })),
  };
}

export async function adminState() {
  const db = database();
  const now = Date.now();
  await expireOrders(now);
  const { config, products } = await storeContext();
  const [queue, recent, occupancy] = await db.batch([
    db.prepare(`SELECT * FROM orders WHERE stage IN ('recebido','em_preparo','pronto')
      ORDER BY (payment='pendente') ASC, slot ASC,
        CASE stage WHEN 'pronto' THEN 0 WHEN 'em_preparo' THEN 1 ELSE 2 END,
        created_at ASC, id ASC LIMIT 300`),
    db.prepare("SELECT * FROM orders WHERE created_at >= ? ORDER BY created_at DESC").bind(now - 7 * 24 * 60 * 60_000),
    db.prepare(`SELECT slot, COUNT(*) as count FROM orders WHERE slot >= ? AND ${occupancyWhere}
      GROUP BY slot ORDER BY slot LIMIT 24`).bind(Math.floor(now / slotMs) * slotMs, now),
  ]);
  const active = (queue.results as unknown as StoredOrder[]).map(r => orderView(r, true));
  const rows = (recent.results as unknown as StoredOrder[]).map(r => orderView(r, true));
  const history = rows.filter(r => ["retirado", "cancelado"].includes(r.stage)).slice(0, 80);
  return { config, products, orders: active, history, metrics: metricsFrom(rows, config, occupancy.results as unknown as { slot: number; count: number }[]), submissions: await getSubmissions() };
}

export async function updateOperation(body: Record<string, unknown>) {
  const { capacity, hours, overrides } = body as unknown as Config;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 15) throw new Problem(400, "Use uma capacidade de 1 a 15 pedidos por janela.");
  if (!Array.isArray(hours) || hours.length !== 7 || hours.some(x => !x || typeof x.open !== "boolean" || !validateSlotTime(x.start) || !validateSlotTime(x.end) || x.start >= x.end)) {
    throw new Problem(400, "Preencha todos os horários com intervalos válidos de 15 minutos.");
  }
  if (!Array.isArray(overrides) || overrides.length > 60 || overrides.some(x => !x || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || !validateSlotTime(x.start) || !validateSlotTime(x.end) || x.start >= x.end || !Number.isInteger(x.capacity) || x.capacity < 0 || x.capacity > 15)) {
    throw new Problem(400, "Confira a data, a faixa de 15 minutos e a capacidade de cada ajuste.");
  }
  await ensureConfig();
  await database().prepare("UPDATE operation SET config=json_set(config, '$.capacity', ?, '$.hours', json(?), '$.overrides', json(?)), revision=revision+1 WHERE id=1")
    .bind(capacity, JSON.stringify(hours), JSON.stringify(overrides)).run();
  return { ok: true };
}

export async function pauseOperation(paused: unknown) {
  if (typeof paused !== "boolean") throw new Problem(400, "Informe se os pedidos estão pausados.");
  await ensureConfig();
  await database().prepare("UPDATE operation SET config=json_set(config, '$.paused', json(?)), revision=revision+1 WHERE id=1").bind(String(paused)).run();
  return { ok: true };
}

function photoPath(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value === "string" && /^\/api\/fotos\/[a-f0-9]{32}$/.test(value)) return value;
  throw new Problem(400, "Envie um arquivo de imagem pelo painel.");
}

function photos() {
  if (!env.BUCKET) throw new Problem(503, "O armazenamento de imagens está indisponível.");
  return env.BUCKET;
}

function findPhoto(path: string | null) {
  return path ? photos().head(`photos/${path.split("/").at(-1)}`) : Promise.resolve(null);
}

async function existingPhoto(value: unknown) {
  const path = photoPath(value);
  const object = await findPhoto(path);
  if (path && !object) throw new Problem(400, "A foto enviada não está disponível. Envie o arquivo novamente.");
  return { path, object };
}

function cents(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) throw new Problem(400, "Informe um preço válido em reais.");
  return value;
}

async function changeProduct(id: string, values: Record<string, unknown>) {
  await ensureConfig();
  const db = database();
  await db.batch([
    db.prepare(`INSERT INTO product_overrides (id, changes) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET changes=json_patch(changes, excluded.changes)`).bind(id, JSON.stringify(values)),
    db.prepare("UPDATE operation SET revision=revision+1 WHERE id=1"),
  ]);
}

export async function updateProduct(id: string, body: Record<string, unknown>) {
  const source = originalProducts.find(p => p.id === id);
  if (!source) throw new Problem(404, "Produto não encontrado.");
  if (body.action === "availability") {
    if (typeof body.disponivel !== "boolean") throw new Problem(400, "Informe a disponibilidade do produto.");
    await changeProduct(id, { disponivel: body.disponivel });
    return { ok: true };
  }
  const nome = textField(body.nome, 85);
  if (!nome) throw new Problem(400, "Informe um nome para o produto.");
  const prices = body.variantPrices;
  const variantes = source.variantes.map((variant, i) => ({ ...variant, preco_centavos: cents(Array.isArray(prices) ? prices[i] : undefined) }));
  const photo = body.foto === undefined ? {} : { foto: (await existingPhoto(body.foto)).path };
  await changeProduct(id, {
    nome, descricao_fonte: textField(body.descricao_fonte, 650),
    preco_centavos: variantes[0]?.preco_centavos ?? cents(body.preco_centavos),
    variantes, ...photo,
  });
  return { ok: true };
}

export async function getSubmissions(): Promise<Submission[]> {
  const { results } = await database().prepare("SELECT student, product, original, edited FROM submissions").all<Submission>();
  return students.map(s => results.find(r => r.student === s.student) ?? { ...s, original: null, edited: null });
}

export async function getPublishedSubmissions(): Promise<PublishedSubmission[]> {
  const submissions = await getSubmissions();
  return Promise.all(submissions.map(async item => {
    try {
      const [original, edited] = await Promise.all([findPhoto(item.original), findPhoto(item.edited)]);
      if (original && edited && original.etag === edited.etag) {
        return { ...item, edited: null, photoStatus: "revisar" };
      }
      const missing = (item.original && !original) || (item.edited && !edited);
      return {
        ...item, original: original ? item.original : null, edited: edited ? item.edited : null,
        photoStatus: original && edited ? "publicado" : missing ? "indisponivel" : "pendente",
      };
    } catch {
      return { ...item, original: null, edited: null, photoStatus: "indisponivel" };
    }
  }));
}

export async function updateSubmission(student: string, body: Record<string, unknown>) {
  if (!students.some(s => s.student === student)) throw new Problem(404, "Integrante não encontrado.");
  if (!originalProducts.some(p => p.id === body.product)) throw new Problem(400, "Escolha um produto do catálogo.");
  const [original, edited] = await Promise.all([existingPhoto(body.original), existingPhoto(body.edited)]);
  if (original.object && edited.object && original.object.etag === edited.object.etag) {
    throw new Problem(400, "A foto original e a versão editada precisam ser arquivos diferentes.");
  }
  await database().prepare(`INSERT INTO submissions (student, product, original, edited) VALUES (?, ?, ?, ?)
    ON CONFLICT(student) DO UPDATE SET product=excluded.product, original=excluded.original, edited=excluded.edited`)
    .bind(student, body.product, original.path, edited.path).run();
  return { ok: true };
}

export async function uploadPhoto(request: Request) {
  const bucket = photos();
  const contentType = request.headers.get("content-type") ?? "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw new Problem(400, "Use uma imagem JPG, PNG ou WebP.");
  const bytes = await readBoundedBody(request, 4 * 1024 * 1024, "A imagem precisa ter até 4 MB.");
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.slice(offset, offset + length));
  const valid = bytes.length > 16 && (
    (contentType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (contentType === "image/png" && ascii(0, 8) === "\x89PNG\r\n\x1a\n") ||
    (contentType === "image/webp" && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP")
  );
  if (!valid) throw new Problem(400, "O arquivo não corresponde ao formato da imagem.");
  const id = randomToken();
  await bucket.put(`photos/${id}`, bytes, { httpMetadata: { contentType } });
  return { url: `/api/fotos/${id}` };
}

export async function readPhoto(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Problem(404, "Imagem não encontrada.");
  const object = await photos().get(`photos/${id}`);
  if (!object) throw new Problem(404, "Imagem não encontrada.");
  return new Response(object.body, {
    headers: { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}
