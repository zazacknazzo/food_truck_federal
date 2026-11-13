import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { finishCheckoutAttempt, pendingCheckoutAttempt, startCheckoutAttempt } from "../lib/checkout-attempt.mjs";

const { Miniflare } = createRequire(resolve("package.json"))("miniflare");
const root=resolve("dist/server");
const chunks=(await readdir(root,{recursive:true})).filter(f=>f.endsWith(".js")&&f!=="index.js");
const sandbox = await mkdtemp(join(tmpdir(), "federal-qa-"));
const options = {
  modules: ["index.js", ...chunks].map(path=>({type:"ESModule",path:resolve(root,path)})), modulesRoot:root,
  compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"], d1Persist: join(sandbox, "d1"), r2Buckets: ["BUCKET"], bindings: { FEDERAL_OPERATORS: "qa@sites.test" },
};
const worker = new Miniflare(options);
const operator = { "oai-authenticated-user-id": "operator", "oai-authenticated-user-email": "qa@sites.test" };
let completedToken;
const viewer = { "oai-authenticated-user-id": "viewer", "oai-authenticated-user-email": "viewer@sites.test" };

async function raw(path, body, headers = {}, type = "application/json", target = worker) {
  return target.dispatchFetch("https://federal.qa/api/"+path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...(body !== undefined ? { "content-type": type } : {}) },
    ...(body !== undefined ? { body: type === "application/json" ? JSON.stringify(body) : body } : {}),
  });
}
async function call(path, body, headers, status = 200) {
  const response = await raw(path, body, headers);
  const data = await response.json();
  assert.equal(response.status, status, path+" · "+JSON.stringify(data));
  return data;
}
function checkoutDraft(overrides = {}) {
  return {
    customer: "Teste Kombi", pickup: "imediata", slot: null, scenario: "aprovado", method: "Pix",
    campaign: "federal-avdi", total: 3900, items: [{
      key: "qa-cart-line", product: "dog-completo", variant: "2-salsichas",
      press: "Prensado", extras: ["bacon"], quantity: 2, note: "Teste",
    }],
    ...overrides,
  };
}

function order(overrides = {}) {
  return { ...checkoutDraft(overrides), requestKey: crypto.randomUUID() };
}

async function checkPeak(config, window, laterWindow) {
  await call("admin/operacao", { ...config, capacity: 10, overrides: [] }, operator);
  const scheduled = overrides => order({ pickup: "agendada", slot: window, scenario: "pendente", ...overrides });
  const firstRequest = scheduled({ customer: "Pico · reserva original" });
  const original = await call("pedido", firstRequest);
  const otherWindow = await call("pedido", scheduled({ slot: laterWindow, scenario: "aprovado" }));
  const requests = [
    ...Array.from({ length: 16 }, (_, index) => scheduled({ customer: `Pico · pedido ${index + 1}` })),
    ...Array.from({ length: 8 }, () => firstRequest),
  ];
  const responses = await Promise.all(requests.map(async request => {
    const start = performance.now();
    const response = await raw("pedido", request);
    const body = await response.json();
    return { status: response.status, body, elapsed: performance.now() - start };
  }));
  const newResponses = responses.slice(0, 16);
  assert.deepEqual(newResponses.map(r => r.status).sort(), [...Array(9).fill(200), ...Array(7).fill(409)]);
  assert.ok(responses.slice(16).every(r => r.status === 200 && r.body.id === original.id && r.body.tracking === original.tracking));
  const accepted = newResponses.filter(r => r.status === 200).map(r => r.body);
  const { orders, metrics } = await call("admin", undefined, operator);
  assert.equal(orders.filter(o => o.slot === window).length, 10);
  assert.equal(new Set([original.id, ...accepted.map(o => o.id)]).size, 10);
  assert.equal((await call("horarios")).slots.find(s => s.start === window).remaining, 0);
  assert.deepEqual(metrics.occupancy.find(s => s.start === window), { start: window, count: 10, capacity: 10 });
  const times = responses.map(r => r.elapsed).sort((a, b) => a - b);
  const percentile = n => Math.round(times[Math.ceil(times.length * n) - 1]);
  console.log(`Pico (24 requisições): 9 novas reservas, 7 conflitos e 8 reenvios. Latência local p50 ${percentile(.5)} ms, p95 ${percentile(.95)} ms, máx. ${percentile(1)} ms.`);

  const [ready, preparing, waiting] = accepted;
  for (const entry of [ready, preparing, waiting]) {
    await call("pagamento-demo/" + entry.tracking, { mode: "demo", action: "aprovado" });
  }
  const start = entry => raw("admin/pedido/" + entry.id, { action: "start" }, operator);
  const doubleStart = await Promise.all([start(ready), start(ready)]);
  assert.deepEqual(doubleStart.map(r => r.status).sort(), [200, 409]);
  await call("admin/pedido/" + ready.id, { action: "ready" }, operator);
  assert.equal((await start(preparing)).status, 200);
  const afterStart = (await call("admin", undefined, operator)).orders;
  const peakQueue = afterStart.filter(o => o.slot === window);
  assert.deepEqual(peakQueue.slice(0, 3).map(o => o.id), [ready.id, preparing.id, waiting.id]);
  assert.ok(peakQueue.slice(3).every(o => o.payment === "pendente"));
  const ordered = afterStart.filter(o => o.payment === "aprovado" && [window, laterWindow].includes(o.slot));
  assert.equal(ordered.at(-1).id, otherWindow.id);
  assert.equal((await call("pedido/" + ready.tracking)).stage, "pronto");

  await call("admin/pausa", { paused: true }, operator);
  assert.equal((await call("horarios")).slots.length, 0);
  await call("pedido", scheduled({ slot: laterWindow }), undefined, 409);
  assert.equal((await call("pedido", firstRequest)).id, original.id);
  const code = (await call("pedido/" + ready.tracking)).code;
  await call("admin/pedido/" + ready.id, { action: "pickup", code }, operator);
  assert.equal((await call("pedido/" + ready.tracking)).stage, "retirado");
  await call("admin/pausa", { paused: false }, operator);

  const db = await worker.getD1Database("DB");
  await db.prepare("UPDATE orders SET expires_at=? WHERE id=?").bind(Date.now() - 1_000, original.id).run();
  assert.equal((await call("horarios")).slots.find(s => s.start === window).remaining, 1);
  assert.equal((await call("pedido/" + original.tracking)).payment, "expirado");
  assert.equal((await call("pedido", scheduled({ customer: "Pico · vaga liberada" }))).slot, window);
  assert.equal((await call("horarios")).slots.find(s => s.start === window).remaining, 0);
  console.log("Pico: fila por prioridade, transição concorrente, pausa, retirada e reutilização de vaga expirada.");
}

try {
  const db = await worker.getD1Database("DB");
  const migrations = (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort();
  async function migrate(file) {
    const sql = await readFile(`drizzle/${file}`, "utf8");
    await db.batch(sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  }
  await migrate(migrations[0]);
  const legacy = "1234567890abcdef1234567890abcdef";
  const legacyKey = crypto.randomUUID();
  await db.prepare(`INSERT INTO orders
    (id,tracking,request_key,code,customer,slot,pickup,items,total,method,payment,stage,created_at,events)
    VALUES ('legacy',?,?,'ABCDE','QA histórico',0,'imediata','[]',3900,'Pix','recusado','cancelado',0,'[]')`).bind(legacy, legacyKey).run();
  for (const file of migrations.slice(1)) await migrate(file);
  assert.equal((await call("pedido/"+legacy)).payment, "recusado");
  await call("pedido", { ...order({ customer: "QA histórico" }), requestKey: legacyKey }, undefined, 409);
  assert.equal((await call("avdi")).filter(item => item.photoStatus === "publicado").length, 0);
  const catalog = await call("loja");
  assert.equal(catalog.products.length, 38);
  assert.deepEqual(catalog.products, JSON.parse(await readFile("lib/catalogo.json","utf8")).produtos);
  const { slots } = await call("horarios");
  assert.ok(slots.length > 50 && slots.every(s=>s.capacity===10 && s.start%900000===0));
  await call("admin",undefined,{},403);
  await call("admin/pausa",{paused:true},viewer,403);
  for (const identity of [{}, viewer, { "oai-authenticated-user-email": operator["oai-authenticated-user-email"] }, { "oai-authenticated-user-id": operator["oai-authenticated-user-id"] }]) {
    await call("admin", undefined, identity, 403);
    await call("admin/pausa", { paused: true }, identity, 403);
    await call("admin/pedido/not-an-order", { action: "start" }, identity, 403);
    assert.equal((await raw("admin/upload", new Uint8Array(24), identity, "image/webp")).status, 403);
  }
  await call("admin/pausa",{paused:true},{...operator,origin:"https://outro.federal.qa"},403);
  await call("admin/pausa", { paused: true }, { ...operator, "sec-fetch-site": "cross-site" }, 403);
  const panel = headers => worker.dispatchFetch("https://federal.qa/painel", { headers });
  assert.match(await (await panel({})).text(), /Entrar com ChatGPT/);
  assert.doesNotMatch(await (await panel(viewer)).text(), /Fila de pedidos/);
  assert.match(await (await panel(operator)).text(), /Operação demonstrativa/);
  await call("admin/pausa/falso/extra",{paused:true},operator,404);
  await call("pedido",{extra:"a".repeat(61_000)},undefined,413);
  const { config } = await call("admin",undefined,operator);
  console.log("38 itens, preços, ingredientes, variantes, autorização e capacidade inicial");

  const draft = checkoutDraft();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const storage = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } });

  const body = startCheckoutAttempt(draft);
  assert.match(body.requestKey, /^[a-f0-9-]{36}$/);
  const [a, duplicate] = await Promise.all([call("pedido", body), call("pedido", body)]);
  assert.equal(a.id, duplicate.id);
  assert.equal(a.tracking, duplicate.tracking);
  assert.equal(a.total, 3900);
  assert.equal(a.items[0].unit, 1950);

  // Losing a successful response and reopening the checkout must recover the same request.
  const reloaded = await import("../lib/checkout-attempt.mjs?reload");
  const retry = reloaded.pendingCheckoutAttempt(structuredClone(draft.items));
  assert.deepEqual(retry, body);
  assert.equal((await call("pedido", retry)).id, a.id);
  assert.equal(reloaded.pendingCheckoutAttempt([{ ...draft.items[0], quantity: 1 }]), null);
  const beforeSecond = (await call("admin", undefined, operator)).orders;
  assert.deepEqual(beforeSecond.map(order => order.id), [a.id]);

  await call("pedido", { ...body, items: [{ ...body.items[0], note: "Dados diferentes" }] }, undefined, 409);
  await call("pedido", { ...body, scenario: "recusado" }, undefined, 409);
  finishCheckoutAttempt(body.requestKey);
  assert.equal(pendingCheckoutAttempt(draft.items), null);
  const cleared = await import("../lib/checkout-attempt.mjs?after-completion");
  assert.equal(cleared.pendingCheckoutAttempt(draft.items), null);

  // All order data, including the cart line key, stays identical in the next attempt.
  const second = startCheckoutAttempt(draft);
  assert.notEqual(second.requestKey, body.requestKey);
  assert.deepEqual(second, { ...body, requestKey: second.requestKey });
  const b = await call("pedido", second);
  assert.notEqual(b.id, a.id);
  assert.notEqual(b.tracking, a.tracking);
  assert.deepEqual(b.items, a.items);
  assert.equal(b.total, a.total);
  assert.equal((await call("admin", undefined, operator)).orders.length, 2);
  assert.equal((await call("pedido", second)).id, b.id);
  finishCheckoutAttempt(second.requestKey);
  if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
  else delete globalThis.sessionStorage;
  await call("admin/pedido/" + b.id, { action: "cancel" }, operator);
  console.log("Tentativa: duplo clique, reenvio após recarregar, compra idêntica nova e conflitos 409");
  assert.match(a.code,/^[A-Z2-9]{5}$/);
  assert.equal(a.demo, true);
  assert.equal(a.campaign, undefined);
  assert.equal(a.request_hash, undefined);
  await call("pedido",{...body,customer:"Outro visitante"},undefined,409);
  assert.equal((await raw("pedido/"+a.tracking)).headers.get("x-federal-mode"),"demo");
  const queue = (await call("admin",undefined,operator)).orders;
  assert.equal(queue.length,1); assert.equal(queue[0].code,undefined); assert.equal(queue[0].tracking,undefined);
  await call("admin/pedido/"+a.id,{action:"ready"},operator,409);
  await call("admin/pedido/"+a.id,{action:"start"},operator);
  assert.equal((await call("pedido/"+a.tracking)).stage,"em_preparo");
  await call("admin/pedido/"+a.id,{action:"ready"},operator);
  assert.equal((await call("pedido/"+a.tracking)).stage,"pronto");
  await call("admin/pedido/"+a.id,{action:"pickup",code:"00000"},operator,400);
  await call("admin/pedido/"+a.id,{action:"pickup",code:a.code.toLowerCase()},operator);
  const delivered = await call("pedido/"+a.tracking);
  assert.equal(delivered.stage,"retirado");
  completedToken = a.tracking;
  assert.equal(delivered.code,undefined);
  const {metrics, history} = await call("admin",undefined,operator);
  assert.equal(metrics.value,3900); assert.equal(metrics.top[0].quantity,2); assert.equal(history.find(order => order.id === a.id).events.length,4);
  await call("pedido/"+a.id,undefined,undefined,404);
  console.log("Pedido idempotente, preparo, código incorreto bloqueado, retirada confirmada e métricas");

  const capSlot=slots.find((s,i)=>i>6 && new Date(s.start).getUTCMinutes()!==45).start;
  const clock=new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  const date=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"});
  const rule={date:date.format(capSlot),start:clock.format(capSlot),end:clock.format(capSlot+900000),capacity:1};
  await call("admin/operacao",{...config,overrides:[rule]},operator);
  const scheduled=(scenario)=>order({pickup:"agendada",slot:capSlot,scenario});
  const sameSlot = scheduled("pendente");
  const [firstHold, repeatedHold] = await Promise.all([call("pedido",sameSlot),call("pedido",sameSlot)]);
  assert.equal(firstHold.id,repeatedHold.id);
  assert.equal((await call("horarios")).slots.find(s=>s.start===capSlot).remaining,0);
  await call("pagamento/"+firstHold.tracking,{action:"recusado"});
  const race=await Promise.all([raw("pedido",scheduled("pendente")),raw("pedido",scheduled("pendente"))]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const winner=await race.find(r=>r.ok).json();
  assert.equal(winner.slot,capSlot); assert.equal(winner.code,undefined);
  assert.equal((await call("horarios")).slots.find(s=>s.start===capSlot).remaining,0);
  await call("pagamento-demo/"+winner.tracking,{type:"payment.updated",data:{id:123}},undefined,400);
  assert.equal((await call("pagamento-demo/"+winner.tracking,{mode:"demo",action:"aprovado"})).payment,"aprovado");
  assert.equal((await call("horarios")).slots.find(s=>s.start===capSlot).remaining,0);
  await call("admin/pedido/"+winner.id,{action:"cancel"},operator);
  assert.equal((await call("pedido/"+winner.tracking)).payment,"reembolsado");
  const hold=await call("pedido",scheduled("pendente"));
  await db.prepare("UPDATE orders SET expires_at=? WHERE id=?").bind(Date.now()-1000,hold.id).run();
  assert.equal((await call("horarios")).slots.find(s=>s.start===capSlot).remaining,1);
  assert.equal((await call("pedido/"+hold.tracking)).payment,"expirado");
  assert.equal((await call("pedido",scheduled("recusado"))).stage,"cancelado");
  assert.equal((await call("pedido",scheduled("expirado"))).payment,"expirado");
  await call("admin/operacao",{...config,overrides:[{...rule,capacity:0}]},operator);
  assert.ok(!(await call("horarios")).slots.some(s=>s.start===capSlot));
  console.log("Agenda, última vaga concorrente, reserva, aprovação, reembolso, recusa e expiração");
  await checkPeak(config, slots[18].start, slots[19].start);

  await call("admin/pausa",{paused:true},operator);
  assert.equal((await call("horarios")).slots.length,0);
  await call("pedido",order(),undefined,409);
  await call("admin/pausa",{paused:false},operator);
  await call("admin/produto/dog-completo",{action:"availability",disponivel:false},operator);
  await call("pedido",order(),undefined,409);
  const upload=async(file)=>{
    const response=await raw("admin/upload",await readFile(file),operator,"image/webp");
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).url;
  };
  const original=await upload("public/media/dogao-original.webp");
  const edited=await upload("public/media/dogao-ia.webp");
  const duplicatePhoto=await upload("public/media/dogao-original.webp");
  await call("admin/avdi/Isaac",{product:"dog-completo",original,edited:duplicatePhoto},operator,400);
  await call("admin/avdi/Isaac",{product:"dog-completo",original,edited:"/api/fotos/"+"0".repeat(32)},operator,400);
  const invalidPhoto=await raw("admin/upload",new Uint8Array(64),operator,"image/png");
  assert.equal(invalidPhoto.status,400);
  const tooBig=await raw("admin/upload",new Uint8Array(4*1024*1024+1),operator,"image/png");
  assert.equal(tooBig.status,413);
  await call("admin/avdi/Isaac",{product:"dog-completo",original,edited:null},operator);
  assert.equal((await call("avdi"))[0].photoStatus,"pendente");
  await call("admin/produto/dog-completo",{action:"availability",disponivel:true},operator);
  assert.equal((await raw(original.replace("/api/",""))).headers.get("content-type"),"image/webp");
  await call("admin/produto/dog-completo",{nome:"Dog Completo",descricao_fonte:catalog.products[1].descricao_fonte,
    disponivel:true,variantPrices:[1290,1450],foto:original},operator);
  await call("pedido",order(),undefined,409);
  assert.equal((await call("pedido",order({total:4100}))).total,4100);
  await call("admin/avdi/Isaac",{product:"dog-completo",original,edited},operator);
  const avdi=await call("avdi");
  assert.equal(avdi.length,4); assert.equal(avdi[0].edited,edited);
  assert.equal(avdi[0].photoStatus,"publicado");
  assert.equal(avdi.filter(item=>item.photoStatus==="pendente").length,3);
  console.log("Pausa, estoque, atualização de preço, upload R2 e publicação AVDI");
} finally {
  await worker.dispose();
  if (!completedToken) await rm(sandbox, { recursive: true, force: true });
}

const resumed = new Miniflare(options);
try {
  const response = await raw("pedido/"+completedToken, undefined, {}, undefined, resumed);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stage, "retirado");
  console.log("Pedido lido do D1 após reiniciar o Worker");
} finally {
  await resumed.dispose();
  await rm(sandbox, { recursive: true, force: true });
}

const withoutBindings = new Miniflare({ ...options, d1Databases: [], r2Buckets: [] });
try {
  const store = await raw("loja",undefined,{},undefined,withoutBindings);
  assert.equal(store.status,503);
  const upload = await raw("admin/upload",new Uint8Array(24),operator,"image/webp",withoutBindings);
  assert.equal(upload.status,503);
  const photo = await raw("fotos/"+"0".repeat(32),undefined,{},undefined,withoutBindings);
  assert.equal(photo.status,503);
  console.log("Falhas de D1 e R2 respondem 503 sem divulgar detalhes internos");
} finally { await withoutBindings.dispose(); }
