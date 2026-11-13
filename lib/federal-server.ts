import { env } from "cloudflare:workers";
import {
  type CartLine, type Config, type Item, type Metrics, type Order,
  type Product, type PublishedSubmission, type Slot, type Stage, type Submission,
  commercialFields, commercialInfoReady, dateKey, defaultConfig, emptyCommercialInfo, extrasFor, originalProducts,
  payments, slotMs, students, time, zone,
} from "./federal";
import { checkoutMode, Problem, providerConfig, readyForCheckout, signedInId } from "./federal-runtime";
import { cancelPaidCheckout, checkoutPaymentLink, paymentSummary } from "./federal-payments";
import { currency } from "./mercado-pago";

type StoredOrder = Omit<Order, "demo" | "tracking" | "code" | "items" | "events"> & {
  tracking: string;
  code: string;
  request_key: string;
  request_hash: string | null;
  items: string;
  events: string;
};

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
  const id = signedInId(headers);
  const permitted = (env.FEDERAL_OPERATORS ?? "").split(/[;,\n]/).map(entry => entry.trim()).filter(Boolean);
  // Sites dispatch supplies the authenticated headers. The Worker has no public origin of its own.
  return Boolean(id && email && permitted.some(entry => {
    const [allowedEmail, allowedId, ...extra] = entry.split("|");
    return extra.length === 0 && allowedEmail.trim().toLowerCase() === email
      && (allowedId === undefined || allowedId.trim() === id);
  }));
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
  const saved = row ? JSON.parse(row.config) as Partial<Config> : {};
  const config = { ...defaultConfig, ...saved, commercial: { ...emptyCommercialInfo, ...saved.commercial } };
  return { config, revision: row?.revision ?? 0, products };
}

export async function publicStore() {
  const { products, config } = await storeContext();
  const mode = checkoutMode();
  return { products, paused: config.paused, mode, ready: readyForCheckout(mode, config),
    commercial: commercialInfoReady(config.commercial) ? config.commercial : null };
}

export async function publicCommercialInfo() {
  try {
    const { config } = await storeContext();
    return commercialInfoReady(config.commercial) ? config.commercial : null;
  } catch {
    // Tracking still renders its own connection and retry state.
    return null;
  }
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

const occupancyWhere = "(payment='aprovado' OR (expires_at > ? AND (stage='aguardando_pagamento' OR (mode='demo' AND payment='pendente'))))";
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

export async function upcomingSlots(config: Config, now = Date.now(), mode = checkoutMode()) {
  if (config.paused) return [];
  const first = Math.ceil((now + config.leadMinutes * 60_000) / slotMs) * slotMs;
  const end = first + 7 * 24 * 60 * 60_000;
  const records = await database().prepare(`SELECT slot, COUNT(*) as count FROM orders WHERE mode=? AND slot >= ? AND slot < ? AND ${occupancyWhere} GROUP BY slot`)
    .bind(mode, first, end, now).all<{ slot: number; count: number }>();
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
  const { tracking, code, events, campaign, mode } = row;
  const order: Order = {
    mode, demo: mode === "demo", id: row.id, customer: row.customer, slot: row.slot, pickup: row.pickup,
    items: JSON.parse(row.items), total: row.total, method: row.method, payment: row.payment, stage: row.stage,
    created_at: row.created_at, expires_at: row.expires_at, started_at: row.started_at,
    ready_at: row.ready_at, picked_at: row.picked_at,
  };
  if (operator) return { ...order, campaign, events: JSON.parse(events) };
  return { ...order, tracking, ...(row.payment === "aprovado" && ["recebido", "em_preparo", "pronto"].includes(row.stage) ? { code } : {}) };
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
    if (product.disponivel === false) throw new Problem(409, `${product.nome} está esgotado.`);
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

export async function expireOrders(now: number, token?: string) {
  const sql = `UPDATE orders SET payment=CASE WHEN payment='pendente' THEN 'expirado' ELSE payment END,
    stage='cancelado', events=json_insert(events, '$[#]', json(?))
    WHERE (stage='aguardando_pagamento' OR (mode='demo' AND payment='pendente'))
      AND expires_at <= ?${token ? " AND tracking=?" : ""}`;
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
  const mode = body.mode ?? "demo";
  if (mode !== "demo" && mode !== "teste" && mode !== "producao") throw new Problem(400, "Confira o modo do checkout.");
  if (mode === "demo" && body.method !== "Pix" && body.method !== "Cartão") throw new Problem(400, "Escolha Pix ou cartão para simular.");
  if (mode !== "demo" && (body.scenario !== undefined || body.method !== undefined)) throw new Problem(400, "O pagamento é definido no Mercado Pago.");
  const method = mode === "demo" ? body.method : "Mercado Pago";
  const payment = mode === "demo" ? body.scenario : "pendente";
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
  const fields = [customer, method, payment, pickup, requestedSlot, body.total, campaign, lines];
  const payload = JSON.stringify(mode === "demo" ? fields : [mode, ...fields]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const requestHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  function checkReplay(row: StoredOrder) {
    if (row.request_hash === null) {
      // Orders from before the hash migration are still accessible by their tracking links.
      throw new Problem(409, "Este envio já foi registrado. Consulte a confirmação em Meus pedidos.");
    }
    if (row.request_hash !== requestHash || row.mode !== mode) throw new Problem(409, "Este envio já foi usado com outros dados. Confira a sacola.");
    return getOrder(row.tracking);
  }
  const findRequest = db.prepare("SELECT * FROM orders WHERE request_key=?").bind(requestKey);
  const repeated = await findRequest.first<StoredOrder>();
  if (repeated) return checkReplay(repeated);

  if (mode !== checkoutMode()) throw new Problem(409, "O modo do checkout mudou. Abra novamente e confira seu pedido.");
  await ensureConfig();
  const { config, revision, products } = await storeContext();
  if (config.paused) throw new Problem(409, "A Kombi pausou novos pedidos.");
  if (!readyForCheckout(mode, config)) throw new Problem(503, "O checkout ainda não está liberado neste ambiente.");
  const provider = mode === "demo" ? null : providerConfig(mode);
  const items = makeItems(body.items, products);
  const total = items.reduce((sum, item) => sum + item.total, 0);
  if (body.total !== total) throw new Problem(409, "O preço do cardápio mudou. Confira o valor atualizado antes de continuar.");
  if (provider && total <= 0) throw new Problem(400, "O pagamento precisa ter um valor maior que zero.");
  const now = Date.now();
  const available = await upcomingSlots(config, now, mode);
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
  const stage: Stage = provider ? "aguardando_pagamento" : payment === "recusado" || payment === "expirado" ? "cancelado" : "recebido";
  const events = JSON.stringify([{ label: provider ? "Reserva criada · aguardando Mercado Pago" : `Pagamento demonstrativo · ${payments[payment]}`, at: now }]);
  // D1 executes the capacity check and the insert in a single SQLite statement.
  const insert = db.prepare(`INSERT INTO orders
    (id, tracking, request_key, request_hash, mode, code, customer, slot, pickup, items, total, method, payment, stage, campaign, created_at, expires_at, events)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT revision FROM operation WHERE id=1) = ?
      AND (SELECT COUNT(*) FROM orders WHERE mode=? AND slot=? AND ${occupancyWhere}) < ?
    ON CONFLICT(request_key) DO NOTHING`)
    .bind(id, tracking, requestKey, requestHash, mode, code, customer, slot.start, pickup, JSON.stringify(items),
      total, method, payment, stage, campaign, now, expiresAt, events, revision, mode, slot.start, now, slot.capacity);
  if (provider) {
    await db.batch([insert, db.prepare(`INSERT INTO payment_checkouts (order_id,collector_id,currency,preference_state,next_check_at)
      SELECT id, ?, ?, 'new', ? FROM orders WHERE id=?`).bind(provider.collectorId, currency, now + 60_000, id)]);
  } else {
    await insert.run();
  }
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
  if ((row.stage === "aguardando_pagamento" || row.mode === "demo" && row.payment === "pendente")
    && row.expires_at !== null && row.expires_at <= now) {
    await expireOrders(now, token);
    const current = await statement.first<StoredOrder>();
    if (current) return orderView(current);
  }
  return orderView(row);
}

export async function resolvePayment(token: string, action: unknown) {
  if (checkoutMode() !== "demo") throw new Problem(409, "O simulador está disponível no modo DEMO.");
  const order = await getOrder(token);
  if (order.mode !== "demo") throw new Problem(409, "O resultado deste pagamento é confirmado pelo Mercado Pago.");
  if (action !== "aprovado" && action !== "recusado" && action !== "expirado") throw new Problem(400, "Resultado inválido.");
  if (order.payment !== "pendente") throw new Problem(409, "O pagamento de teste já foi resolvido.");
  const now = Date.now();
  const update = await database().prepare(`UPDATE orders SET payment=?, stage=?, expires_at=NULL,
    events=json_insert(events,'$[#]',json(?)) WHERE tracking=? AND mode='demo' AND payment='pendente' AND expires_at > ?`)
    .bind(action, action === "aprovado" ? "recebido" : "cancelado", JSON.stringify({ label: `Pagamento demonstrativo · ${payments[action]}`, at: now }), token, now).run();
  if (!update.meta.changes) throw new Problem(409, "A reserva mudou. Atualize o acompanhamento.");
  return getOrder(token);
}

export async function getCheckoutLink(token: string) {
  const order = await getOrder(token);
  if (order.mode === "demo" || order.mode !== checkoutMode()) throw new Problem(409, "O pagamento deste pedido está indisponível no ambiente atual.");
  if (order.mode === "producao" && !readyForCheckout(order.mode, (await storeContext()).config)) {
    throw new Problem(503, "O checkout ainda não está liberado neste ambiente.");
  }
  if (order.stage !== "aguardando_pagamento") throw new Problem(409, "A reserva já foi encerrada ou o pagamento foi confirmado.");
  const url = await checkoutPaymentLink(database(), providerConfig(order.mode), order.id, true);
  if (!url) throw new Problem(503, "O link ainda não está disponível. Tente de novo antes do fim da reserva.");
  return { url };
}

export async function moveOrder(id: string, action: unknown, inputCode: unknown, actor: string) {
  const db = database();
  await expireOrders(Date.now());
  const row = await db.prepare("SELECT * FROM orders WHERE id=?").bind(id).first<StoredOrder>();
  if (!row) throw new Problem(404, "Pedido não encontrado.");
  if (row.mode !== checkoutMode()) throw new Problem(409, "O pedido pertence a outro ambiente.");
  if (action === "cancel" && row.mode !== "demo") return cancelPaidCheckout(db, providerConfig(row.mode), id, actor);
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
  const mode = checkoutMode();
  await expireOrders(now);
  const { config, products } = await storeContext();
  const [queue, recent, occupancy] = await db.batch([
    db.prepare(`SELECT * FROM orders WHERE mode=? AND stage IN ('aguardando_pagamento','recebido','em_preparo','pronto')
      ORDER BY (payment<>'aprovado') ASC, slot ASC,
        CASE stage WHEN 'pronto' THEN 0 WHEN 'em_preparo' THEN 1 ELSE 2 END,
        created_at ASC, id ASC LIMIT 300`).bind(mode),
    db.prepare("SELECT * FROM orders WHERE mode=? AND created_at >= ? ORDER BY created_at DESC").bind(mode, now - 7 * 24 * 60 * 60_000),
    db.prepare(`SELECT slot, COUNT(*) as count FROM orders WHERE mode=? AND slot >= ? AND ${occupancyWhere}
      GROUP BY slot ORDER BY slot LIMIT 24`).bind(mode, Math.floor(now / slotMs) * slotMs, now),
  ]);
  const active = (queue.results as unknown as StoredOrder[]).map(r => orderView(r, true));
  const rows = (recent.results as unknown as StoredOrder[]).map(r => orderView(r, true));
  const history = rows.filter(r => ["retirado", "cancelado"].includes(r.stage)).slice(0, 80);
  return { mode, config, products, orders: active, history,
    metrics: metricsFrom(rows, config, occupancy.results as unknown as { slot: number; count: number }[]),
    finance: mode === "demo" ? null : await paymentSummary(db, mode), submissions: await getSubmissions() };
}

export async function updateOperation(body: Record<string, unknown>) {
  const { capacity, leadMinutes, hours, overrides } = body as unknown as Config;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 15) throw new Problem(400, "Use uma capacidade de 1 a 15 pedidos por janela.");
  if (leadMinutes !== undefined && (!Number.isInteger(leadMinutes) || leadMinutes < 10 || leadMinutes > 120)) {
    throw new Problem(400, "Use uma antecedência de 10 a 120 minutos.");
  }
  if (!Array.isArray(hours) || hours.length !== 7 || hours.some(x => !x || typeof x.open !== "boolean" || !validateSlotTime(x.start) || !validateSlotTime(x.end) || x.start >= x.end)) {
    throw new Problem(400, "Preencha todos os horários com intervalos válidos de 15 minutos.");
  }
  if (!Array.isArray(overrides) || overrides.length > 60 || overrides.some(x => !x || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || !validateSlotTime(x.start) || !validateSlotTime(x.end) || x.start >= x.end || !Number.isInteger(x.capacity) || x.capacity < 0 || x.capacity > 15)) {
    throw new Problem(400, "Confira a data, a faixa de 15 minutos e a capacidade de cada ajuste.");
  }
  await ensureConfig();
  await database().prepare("UPDATE operation SET config=json_patch(config, ?), revision=revision+1 WHERE id=1")
    .bind(JSON.stringify({ capacity, hours, overrides, leadMinutes })).run();
  return { ok: true };
}

export async function updateCommercialInfo(body: Record<string, unknown>) {
  const commercial = { ...emptyCommercialInfo };
  for (const { key, limit } of commercialFields) {
    const value = body[key];
    if (typeof value !== "string" || value.length > limit) throw new Problem(400, "Confira o tamanho dos campos comerciais.");
    commercial[key] = value.trim();
  }
  if (typeof body.reviewed !== "boolean") throw new Problem(400, "Informe se os dados foram conferidos.");
  commercial.reviewed = body.reviewed;
  if (commercial.reviewed && !commercialInfoReady(commercial)) throw new Problem(400, "Complete todos os dados antes de publicá-los.");
  await ensureConfig();
  await database().prepare("UPDATE operation SET config=json_set(config,'$.commercial',json(?)), revision=revision+1 WHERE id=1")
    .bind(JSON.stringify(commercial)).run();
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
