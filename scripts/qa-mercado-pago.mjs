import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve("package.json"));
const { Miniflare, Response: WorkerResponse } = require("miniflare");
const root = resolve("dist/server");
const chunks = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".js") && file !== "index.js");
const origin = "https://federal.qa";
const seller = "998877";
const secret = "qa-webhook-key-for-local-fixture";
const cronSecret = "qa-scheduler-fixture-secret-0123456789";
const operator = { "oai-authenticated-user-id": "qa-id", "oai-authenticated-user-email": "qa@sites.test" };
const bindings = {
  FEDERAL_MODE: "teste", FEDERAL_PUBLIC_ORIGIN: origin,
  FEDERAL_MP_TEST_ACCESS_TOKEN: "fixture-test-token", FEDERAL_MP_TEST_WEBHOOK_SECRET: secret,
  FEDERAL_MP_TEST_COLLECTOR_ID: seller, FEDERAL_RECONCILIATION_SECRET: cronSecret,
  FEDERAL_OPERATORS: "qa@sites.test|qa-id",
};

const preferences = new Map();
const payments = new Map();
const merchants = new Map();
const refunds = new Map();
const refundKeys = [];
const outboundRequests = [];
let preferencePosts = 0;
let paymentGets = 0;
let sellerIsTest = true;
let failPreference = false;
let failPayment = false;
let failRefund = false;
let paymentSequence = 5000;

function providerResponse(body, status = 200) {
  return new WorkerResponse(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fakeProvider(request) {
  const url = new URL(request.url);
  outboundRequests.push([url.origin, url.pathname, request.headers.has("authorization")]);
  assert.equal(request.headers.get("authorization"), "Bearer fixture-test-token");
  if (url.origin === "https://api.mercadolibre.com" && url.pathname === "/users/me") {
    return providerResponse({ id: Number(seller), tags: sellerIsTest ? ["test_user"] : [] });
  }
  assert.equal(url.origin, "https://api.mercadopago.com", "Unmocked outbound request");
  if (url.pathname === "/checkout/preferences" && request.method === "POST") {
    const input = await request.json();
    preferencePosts++;
    assert.equal(request.headers.get("x-idempotency-key"), input.external_reference);
    assert.equal(input.expires, true);
    assert.equal(Date.parse(input.expiration_date_to) - Date.parse(input.expiration_date_from), 300_000);
    assert.equal(input.notification_url, origin + "/api/mercado-pago/webhook/teste");
    for (const [status, result] of Object.entries({ success: "aprovado", pending: "pendente", failure: "recusado" })) {
      const callback = new URL(input.back_urls[status]);
      assert.equal(callback.origin, origin);
      assert.match(callback.pathname, /^\/pedido\/[a-f0-9]{32}$/);
      assert.equal(callback.searchParams.get("retorno"), result);
    }
    const id = "test-preference-" + preferencePosts;
    const preference = {
      ...input, id, collector_id: Number(seller),
      init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=" + id,
    };
    preferences.set(id, preference);
    return failPreference ? providerResponse({}, 502) : providerResponse(preference, 201);
  }
  if (url.pathname === "/checkout/preferences/search") {
    const elements = [...preferences.values()].filter(p => p.external_reference === url.searchParams.get("external_reference"));
    return providerResponse({ elements: elements.map(({ id }) => ({ id })), total: elements.length });
  }
  if (url.pathname.startsWith("/checkout/preferences/")) {
    const found = preferences.get(url.pathname.split("/").at(-1));
    return providerResponse(found ?? {}, found ? 200 : 404);
  }
  if (url.pathname.startsWith("/merchant_orders/")) {
    const found = merchants.get(url.pathname.split("/").at(-1));
    return providerResponse(found ?? {}, found ? 200 : 404);
  }
  if (url.pathname === "/v1/payments/search") {
    const matches = [...payments.values()].filter(p => p.external_reference === url.searchParams.get("external_reference"));
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return providerResponse({ paging: { total: matches.length }, results: matches.slice(offset, offset + limit).map(({ id }) => ({ id })) });
  }
  const match = url.pathname.match(/^\/v1\/payments\/(\d+)(\/refunds)?$/);
  assert.ok(match, "Unexpected Mercado Pago path " + url.pathname);
  const id = match[1];
  if (match[2] && request.method === "POST") {
    assert.deepEqual(await request.json(), {});
    const key = request.headers.get("x-idempotency-key");
    assert.match(key, /^[a-f0-9-]{36}$/);
    refundKeys.push(key);
    const refund = refunds.get(key) ?? { id: 9000 + refunds.size, payment_id: Number(id), status: "approved" };
    refunds.set(key, refund);
    return failRefund ? providerResponse({}, 504) : providerResponse(refund, 201);
  }
  paymentGets++;
  const payment = payments.get(id);
  if (failPayment) return providerResponse({}, 503);
  return providerResponse(payment ?? {}, payment ? 200 : 404);
}

const workerOptions = {
  modules: ["index.js", ...chunks].map(path => ({ type: "ESModule", path: resolve(root, path) })),
  modulesRoot: root, compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"], r2Buckets: ["BUCKET"], outboundService: fakeProvider, bindings,
};
const worker = new Miniflare(workerOptions);

async function raw(path, { body, headers, method } = {}, target = worker) {
  return target.dispatchFetch(origin + path, {
    redirect: "manual",
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(path, status = 200, options, target) {
  const response = await raw("/api/" + path, options, target);
  const body = await response.json();
  assert.equal(response.status, status, path + " · " + JSON.stringify(body));
  return body;
}

function draft(slot, extra = {}) {
  return {
    mode: "teste", requestKey: crypto.randomUUID(), customer: "QA Mercado Pago", total: 1290,
    pickup: "agendada", slot, items: [{ product: "dog-completo", variant: "1-salsicha", press: "Prensado", extras: [], note: "", quantity: 1 }],
    ...extra,
  };
}

function preferencePath(order) { return "mercado-pago/preferencia/" + order.tracking; }
function publicOrder(order) { return call("pedido/" + order.tracking); }
function reconcile(order) { return call("admin/conciliar/" + order.id, 200, { body: {}, headers: operator }); }

function providerPayment(order, override = {}) {
  const id = String(++paymentSequence);
  const preference = [...preferences.values()].find(p => p.external_reference === order.id);
  const merchantId = Number(id) + 100_000;
  const now = new Date().toISOString();
  const payment = {
    id: Number(id), order: { id: merchantId, type: "mercadopago" },
    collector_id: Number(seller), currency_id: "BRL", transaction_amount: "12.90", transaction_amount_refunded: 0,
    external_reference: order.id, live_mode: false, status: "approved", status_detail: "accredited",
    date_last_updated: now, date_approved: now, payer: { email: "private-provider-test-field@example.invalid" },
    ...override,
  };
  merchants.set(String(merchantId), {
    id: merchantId, preference_id: preference?.id, external_reference: order.id, collector: { id: Number(seller) },
    payments: [{ id: payment.id }],
  });
  payments.set(id, payment);
  return id;
}

function notice(id, { mode = "teste", requestId = crypto.randomUUID(), timestamp = String(Date.now()), signatureSecret = secret } = {}) {
  const signature = createHmac("sha256", signatureSecret).update(`id:${id};request-id:${requestId};ts:${timestamp};`).digest("hex");
  return {
    path: `mercado-pago/webhook/${mode}?data.id=${id}&type=payment`,
    options: { body: { type: "payment", data: { id: "1" }, status: "approved", live_mode: true },
      headers: { "x-request-id": requestId, "x-signature": `ts=${timestamp},v1=${signature}` } },
  };
}

function notify(id, status = 200, settings) {
  const delivery = notice(id, settings);
  return call(delivery.path, status, delivery.options);
}

try {
  const db = await worker.getD1Database("DB");
  for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) {
    const sql = await readFile("drizzle/" + file, "utf8");
    await db.batch(sql.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
  }

  const { slots } = await call("horarios");
  assert.equal((await call("loja")).mode, "teste");
  const { config } = await call("admin", 200, { headers: operator });
  await call("admin", 403, { headers: { ...operator, "oai-authenticated-user-id": "another-id" } });
  await call("admin/conciliar", 403, { body: {} });
  await call("mercado-pago/conciliar/teste", 403, { body: {}, headers: { authorization: "Bearer " + "x".repeat(32) } });
  await call("admin/operacao", 400, { body: { ...config, leadMinutes: 9 }, headers: operator });
  await call("admin/operacao", 200, { body: { ...config, leadMinutes: 40, capacity: 1 }, headers: operator });
  const { slots: updatedSlots } = await call("horarios");
  assert.ok(updatedSlots[0].start >= Date.now() + 39 * 60_000);
  await call("admin/comercial", 400, { body: { ...config.commercial, reviewed: true }, headers: operator });
  const sellerDraft = Object.fromEntries(Object.keys(config.commercial).map(key => [key, key === "reviewed" ? false : "Campo de teste"]));
  await call("admin/comercial", 200, { body: sellerDraft, headers: operator });
  assert.equal((await call("loja")).commercial, null);
  await call("admin/comercial", 200, { body: { ...sellerDraft, reviewed: true }, headers: operator });
  assert.equal((await call("loja")).commercial.contact, "Campo de teste");
  const [firstSlot, lateSlot, recoverySlot, noWebhookSlot, sellerSlot, busySlot] = slots.slice(8, 14).map(s => s.start);
  await call("pedido", 409, { body: draft(firstSlot, { mode: "demo", scenario: "aprovado", method: "Pix" }) });
  await call("pedido", 400, { body: draft(firstSlot, { scenario: "aprovado" }) });
  await call("pedido", 409, { body: draft(firstSlot, { total: 1 }) });
  console.log("Configuração comercial, antecedência, autorização por ID e isolamento do modo de teste.");

  const firstDraft = draft(firstSlot);
  const [first, replay] = await Promise.all([call("pedido", 200, { body: firstDraft }), call("pedido", 200, { body: firstDraft })]);
  assert.equal(first.id, replay.id);
  assert.equal(first.stage, "aguardando_pagamento");
  assert.equal(first.code, undefined);
  assert.equal((await call("admin", 200, { headers: operator })).metrics.approved, 0);
  await call("admin/pedido/" + first.id, 409, { body: { action: "start" }, headers: operator });
  await call("pagamento-demo/" + first.tracking, 409, { body: { mode: "demo", action: "aprovado" } });
  const forgedReturn = await raw(`/pedido/${first.tracking}?status=approved&payment_id=111`);
  assert.equal(forgedReturn.status, 307);
  assert.equal(new URL(forgedReturn.headers.get("location"), origin).pathname, "/pedido/" + first.tracking);
  assert.equal((await publicOrder(first)).payment, "pendente");
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => raw("/api/" + preferencePath(first), { body: {} })));
  assert.ok(concurrent.some(response => response.status === 200), JSON.stringify({
    statuses: concurrent.map(response => response.status), preferencePosts, outboundRequests,
    events: (await db.prepare("SELECT outcome FROM payment_events").all()).results,
  }));
  assert.ok(concurrent.every(response => [200, 503].includes(response.status)));
  assert.equal(preferencePosts, 1);
  const { url } = await call(preferencePath(first), 200, { body: {} });
  assert.equal(url, "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=test-preference-1");
  assert.equal(preferencePosts, 1);
  const race = await Promise.all(Array.from({ length: 12 }, () => raw("/api/pedido", { body: draft(busySlot) })));
  assert.equal(race.filter(response => response.status === 200).length, 1);
  assert.equal(race.filter(response => response.status === 409).length, 11);
  console.log("Reserva e preferência idempotentes (6 chamadas concorrentes, 1 POST). Capacidade respeitada com 12 pedidos concorrentes.");

  const attempts = [
    { transaction_amount: "12.91" }, { currency_id: "USD" }, { collector_id: 123 }, { live_mode: true },
    { external_reference: crypto.randomUUID() },
  ];
  for (const override of attempts) await notify(providerPayment(first, override));
  const wrongPreference = providerPayment(first);
  merchants.get(String(payments.get(wrongPreference).order.id)).preference_id = "different-preference";
  await notify(wrongPreference);
  assert.equal((await publicOrder(first)).stage, "aguardando_pagamento");
  const paymentId = providerPayment(first);
  const firstNotice = notice(paymentId);
  const beforeInvalid = paymentGets;
  await notify(paymentId, 401, { signatureSecret: "incorrect" });
  await notify(paymentId, 401, { timestamp: String(Date.now() + 360_000) });
  await call(firstNotice.path + "&data.id=" + paymentId, 401, firstNotice.options);
  await call(firstNotice.path.replace("type=payment", "type=topic_merchant_order_wh"), 200, firstNotice.options);
  assert.equal(paymentGets, beforeInvalid);
  await Promise.all([call(firstNotice.path, 200, firstNotice.options), call(firstNotice.path, 200, firstNotice.options)]);
  const afterFirst = paymentGets;
  await call(firstNotice.path, 200, firstNotice.options);
  assert.equal(paymentGets, afterFirst);
  assert.equal((await publicOrder(first)).stage, "recebido");
  const verification = await db.prepare(`SELECT from_payment,to_payment,provider_status FROM payment_events
    WHERE order_id=? AND outcome='payment_verified'`).bind(first.id).all();
  assert.deepEqual(verification.results, [{ from_payment: "pendente", to_payment: "aprovado", provider_status: "approved" }]);
  const original = payments.get(paymentId);
  payments.set(paymentId, { ...original, status: "pending", status_detail: "pending_waiting_payment",
    date_last_updated: new Date(Date.parse(original.date_last_updated) - 60_000).toISOString() });
  await notify(paymentId);
  assert.equal((await publicOrder(first)).payment, "aprovado");
  payments.set(paymentId, original);
  const staleConflictOrder = await call("pedido", 200, { body: draft(slots[16].start) });
  await call(preferencePath(staleConflictOrder), 200, { body: {} });
  payments.set(paymentId, { ...original, external_reference: staleConflictOrder.id });
  await notify(paymentId);
  assert.equal((await publicOrder(staleConflictOrder)).stage, "aguardando_pagamento");
  payments.set(paymentId, original);
  const extraId = providerPayment(first);
  await notify(extraId);
  assert.equal((await publicOrder(first)).payment, "aprovado");
  assert.equal(await db.prepare("SELECT refund_state FROM payment_records WHERE payment_id=?").bind(extraId).first("refund_state"), "requested");
  const panel = await call("admin", 200, { headers: operator });
  assert.equal(panel.metrics.approved, 1);
  assert.equal(panel.finance.refunds, 1);
  assert.deepEqual(panel.finance.problems, [{ orderId: first.id, paymentId: extraId, state: "requested" }]);
  assert.equal(JSON.stringify(panel).includes("private-provider-test-field"), false);
  await call("admin/pedido/" + first.id, 200, { body: { action: "start" }, headers: operator });
  await call("admin/pedido/" + first.id, 200, { body: { action: "ready" }, headers: operator });
  const code = (await publicOrder(first)).code;
  await call("admin/pedido/" + first.id, 200, { body: { action: "pickup", code }, headers: operator });
  assert.equal((await publicOrder(first)).stage, "retirado");
  console.log("Webhooks assinados: rejeição de assinatura e dados divergentes, deduplicação, evento fora de ordem e pagamento duplicado sem novo preparo.");

  const late = await call("pedido", 200, { body: draft(lateSlot) });
  await call(preferencePath(late), 200, { body: {} });
  const lateId = providerPayment(late);
  await db.prepare("UPDATE orders SET expires_at=? WHERE id=?").bind(Date.now() - 1, late.id).run();
  const replacement = await call("pedido", 200, { body: draft(lateSlot) });
  await notify(lateId);
  assert.equal((await publicOrder(late)).stage, "cancelado");
  assert.equal((await publicOrder(late)).payment, "estorno_solicitado");
  assert.equal((await publicOrder(late)).code, undefined);
  assert.equal((await publicOrder(replacement)).stage, "aguardando_pagamento");
  assert.equal((await call("horarios")).slots.find(s => s.start === lateSlot).remaining, 0);
  failRefund = true;
  await call("admin/conciliar/" + late.id, 503, { body: {}, headers: operator });
  failRefund = false;
  const key = refundKeys.at(-1);
  await db.prepare("UPDATE payment_records SET refund_attempted_at=0 WHERE payment_id=?").bind(lateId).run();
  await reconcile(late);
  assert.equal(refundKeys.at(-1), key);
  assert.equal(refunds.size, 1);
  assert.equal((await publicOrder(late)).payment, "estorno_solicitado");
  payments.set(lateId, { ...payments.get(lateId), status: "refunded", status_detail: "refunded",
    transaction_amount_refunded: "12.90", date_last_updated: new Date(Date.now() + 1_000).toISOString() });
  await notify(lateId);
  assert.equal((await publicOrder(late)).payment, "reembolsado");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM payment_records WHERE order_id=?").bind(late.id).first("n"), 1);
  console.log("Aprovação após expiração sem tomar vaga de outro pedido. Estorno repetido com a mesma chave e confirmado apenas por consulta.");

  const recovery = await call("pedido", 200, { body: draft(recoverySlot) });
  failPreference = true;
  await call(preferencePath(recovery), 503, { body: {} });
  failPreference = false;
  const count = preferencePosts;
  await db.prepare("UPDATE payment_checkouts SET preference_started_at=? WHERE order_id=?").bind(Date.now() - 20_000, recovery.id).run();
  await call(preferencePath(recovery), 200, { body: {} });
  assert.equal(preferencePosts, count);
  const recoveredId = providerPayment(recovery);
  const retryNotice = notice(recoveredId);
  failPayment = true;
  await call(retryNotice.path, 503, retryNotice.options);
  assert.equal((await publicOrder(recovery)).payment, "pendente");
  failPayment = false;
  await db.prepare("UPDATE payment_events SET updated_at=0 WHERE payment_id=? AND outcome='retry'").bind(recoveredId).run();
  await call("mercado-pago/conciliar/teste", 200, { body: {}, headers: { authorization: "Bearer " + cronSecret } });
  assert.equal((await publicOrder(recovery)).payment, "aprovado");

  const noWebhook = await call("pedido", 200, { body: draft(noWebhookSlot) });
  await call(preferencePath(noWebhook), 200, { body: {} });
  const refusedId = providerPayment(noWebhook, { status: "rejected", status_detail: "cc_rejected_other_reason", date_approved: null });
  await notify(refusedId);
  assert.equal((await publicOrder(noWebhook)).payment, "recusado");
  assert.equal((await publicOrder(noWebhook)).stage, "aguardando_pagamento");
  const noWebhookId = providerPayment(noWebhook);
  await reconcile(noWebhook);
  assert.equal((await publicOrder(noWebhook)).payment, "aprovado");
  await call("admin/pedido/" + noWebhook.id, 200, { body: { action: "cancel" }, headers: operator });
  assert.equal((await publicOrder(noWebhook)).payment, "estorno_solicitado");
  assert.equal(await db.prepare("SELECT actor_id FROM payment_events WHERE order_id=? AND outcome='refund_requested_by_operator'")
    .bind(noWebhook.id).first("actor_id"), "qa-id");
  assert.equal(await db.prepare("SELECT refund_state FROM payment_records WHERE payment_id=?").bind(noWebhookId).first("refund_state"), "requested");
  const wrongSeller = await call("pedido", 200, { body: draft(sellerSlot) });
  sellerIsTest = false;
  const beforeSellerFailure = preferencePosts;
  await call(preferencePath(wrongSeller), 503, { body: {} });
  assert.equal(preferencePosts, beforeSellerFailure);
  sellerIsTest = true;
  await db.prepare("UPDATE payment_events SET created_at=0 WHERE order_id=? AND outcome='seller_verification_failed'").bind(wrongSeller.id).run();
  await call(preferencePath(wrongSeller), 200, { body: {} });
  console.log("Recuperação após falhas do provedor, conciliação sem webhook, recusa com nova tentativa e vendedor de teste verificado.");

  const gated = new Miniflare({ ...workerOptions, bindings: { ...bindings, FEDERAL_MODE: "producao" } });
  try {
    const gatedDb = await gated.getD1Database("DB");
    for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) {
      const sql = await readFile("drizzle/" + file, "utf8");
      await gatedDb.batch(sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean).map(s => gatedDb.prepare(s)));
    }
    assert.equal((await call("loja", 200, {}, gated)).mode, "demo");
    await call("pedido", 409, { body: draft(firstSlot, { mode: "producao" }) }, gated);
    await call("mercado-pago/webhook/producao?data.id=123", 503, { body: {} }, gated);
  } finally { await gated.dispose(); }
  console.log("Produção bloqueada sem autorização. Todas as respostas do Mercado Pago foram simuladas.");
} finally {
  await worker.dispose();
}
