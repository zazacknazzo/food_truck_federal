import { type MercadoPagoMode, type Mode, type Payment, type Stage } from "./federal";
import { checkoutMode, Problem, productionAuthorized, providerConfig, type MercadoPagoConfig } from "./federal-runtime";
import {
  acceptsPaymentTopic, createPreference, currency, getPayment, MercadoPagoError, recoverPreference, requestFullRefund,
  searchPayments, type ProviderPayment, verifyPaymentNotice, verifyPaymentPreference, verifySeller,
} from "./mercado-pago";

const minute = 60_000;
const providerCallGrace = 10_000;
const reconcileLookback = 120 * 24 * 60 * minute;
const orderCheckout = `SELECT o.id, o.tracking, o.mode, o.payment, o.stage, o.total, o.created_at, o.expires_at, o.slot,
  c.collector_id, c.currency, c.preference_state, c.preference_started_at, c.preference_id, c.checkout_url,
  c.primary_payment_id, c.next_check_at, c.search_offset, c.version
  FROM payment_checkouts c JOIN orders o ON o.id=c.order_id`;
const writeGuard = "EXISTS (SELECT 1 FROM payment_checkouts WHERE order_id=? AND write_id=?)";

type Checkout = {
  id: string; tracking: string; mode: MercadoPagoMode; payment: Payment; stage: Stage;
  total: number; created_at: number; expires_at: number; slot: number;
  collector_id: string; currency: string; preference_state: string;
  preference_started_at: number | null; preference_id: string | null; checkout_url: string | null;
  primary_payment_id: string | null; next_check_at: number; search_offset: number; version: number;
};
type RefundState = "none" | "requested" | "confirmed" | "review";
type PaymentRecord = {
  payment_id: string; order_id: string; provider_status: string; provider_detail: string;
  provider_updated_at: number; refunded_amount: number; refund_state: RefundState;
  refund_id: string | null; refund_key: string | null;
};
type Source = "webhook" | "reconciliation" | "operator" | "checkout" | "refund";
type Event = {
  id: string; mode: MercadoPagoMode; source: Source; order?: string; payment?: string; request?: string; actor?: string;
  from?: Payment; to?: Payment;
  snapshot?: Pick<ProviderPayment, "status" | "updatedAt" | "refunded">;
};

function checkoutFor(db: D1Database, id: string, mode: MercadoPagoMode) {
  return db.prepare(`${orderCheckout} WHERE o.id=? AND o.mode=?`).bind(id, mode).first<Checkout>();
}

function audit(db: D1Database, event: Event, outcome: string, write?: string) {
  const now = Date.now();
  const sql = `INSERT INTO payment_events (id,mode,source,order_id,payment_id,request_id,actor_id,outcome,
      from_payment,to_payment,provider_status,provider_updated_at,refunded_amount,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${write ? writeGuard : "1=1"}
    ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome, order_id=COALESCE(excluded.order_id,payment_events.order_id),
      from_payment=excluded.from_payment,to_payment=excluded.to_payment,provider_status=excluded.provider_status,
      provider_updated_at=excluded.provider_updated_at,refunded_amount=excluded.refunded_amount,
      updated_at=excluded.updated_at WHERE payment_events.outcome IN ('queued','retry')`;
  return db.prepare(sql).bind(event.id, event.mode, event.source, event.order ?? null, event.payment ?? null,
    event.request ?? null, event.actor ?? null, outcome, event.from ?? null, event.to ?? null,
    event.snapshot?.status ?? null, event.snapshot?.updatedAt ?? null, event.snapshot?.refunded ?? null,
    now, now, ...(write ? [event.order, write] : []));
}

function eventFor(config: MercadoPagoConfig, source: Source, order?: string, payment?: string): Event {
  return { id: crypto.randomUUID(), mode: config.mode, source, order, payment };
}

function reserved(order: Checkout, now: number) {
  return order.stage === "aguardando_pagamento" && order.expires_at > now && order.slot > now;
}

function verifyCollector(order: Checkout, config: MercadoPagoConfig) {
  if (order.collector_id !== config.collectorId || order.currency !== currency) {
    throw new Problem(503, "A conta Mercado Pago do pedido precisa ser conferida.");
  }
}

export async function checkoutPaymentLink(db: D1Database, config: MercadoPagoConfig, id: string, allowCreate: boolean) {
  const order = await checkoutFor(db, id, config.mode);
  if (!order) throw new Problem(404, "Pedido não encontrado.");
  verifyCollector(order, config);
  const now = Date.now();
  if (!reserved(order, now)) return null;
  if (order.preference_state === "ready") return order.checkout_url;

  let create = false;
  const event = eventFor(config, "checkout", order.id);
  if (allowCreate && order.preference_state === "new") {
    const sellerFailure = await db.prepare(`SELECT 1 AS failed FROM payment_events WHERE order_id=?
      AND outcome='seller_verification_failed' AND created_at>? LIMIT 1`).bind(order.id, now - providerCallGrace).first();
    if (sellerFailure) return null;
    try { await verifySeller(config); } catch {
      await audit(db, event, "seller_verification_failed").run();
      return null;
    }
    // A lost POST response is recovered by reference. The API does not
    // document safe replay of POST /checkout/preferences.
    const claimedAt = Date.now();
    const claim = await db.prepare(`UPDATE payment_checkouts SET preference_state='started', preference_started_at=?
        WHERE order_id=? AND preference_state='new' AND EXISTS
        (SELECT 1 FROM orders WHERE id=? AND stage='aguardando_pagamento' AND expires_at>?)`)
      .bind(claimedAt, id, id, claimedAt).run();
    if (!claim.meta.changes) return null;
    create = true;
  } else if (!order.preference_started_at || now - order.preference_started_at < providerCallGrace
    || order.preference_state === "blocked") {
    return null;
  }

  let preference;
  try {
    preference = await (create ? createPreference(config, order) : recoverPreference(config, order));
  } catch (error) {
    const rejected = create && error instanceof MercadoPagoError && [400, 401, 403, 422].includes(error.status ?? 0);
    await db.batch([
      db.prepare(`UPDATE payment_checkouts SET preference_state=? WHERE order_id=? AND preference_state IN ('started','unknown')`)
        .bind(rejected ? "blocked" : "unknown", order.id),
      audit(db, event, rejected ? "preference_rejected" : "preference_unknown"),
    ]);
    return null;
  }
  if (!preference) {
    await audit(db, event, "preference_not_found").run();
    return null;
  }
  await db.batch([
    db.prepare(`UPDATE payment_checkouts SET preference_id=?, checkout_url=?, preference_state='ready'
      WHERE order_id=? AND preference_state IN ('started','unknown')`).bind(preference.id, preference.url, order.id),
    audit(db, event, create ? "preference_created" : "preference_recovered"),
  ]);
  const current = await checkoutFor(db, id, config.mode);
  return current && reserved(current, Date.now()) ? current.checkout_url : null;
}

function matches(config: MercadoPagoConfig, order: Checkout, payment: ProviderPayment) {
  return payment.externalReference === order.id && payment.collector === order.collector_id
    && payment.collector === config.collectorId && payment.currency === order.currency && payment.currency === currency
    && payment.amount === order.total && payment.live === (config.mode === "producao");
}

function paymentKind(payment: ProviderPayment) {
  if (payment.refunded === payment.amount && payment.amount > 0 && ["refunded", "approved"].includes(payment.status)) return "refunded";
  if (payment.refunded > 0 || ["charged_back", "in_mediation", "refunded"].includes(payment.status)) return "review";
  if (payment.status === "approved" && payment.detail === "accredited") return "approved";
  if (["pending", "in_process", "authorized"].includes(payment.status)) return "pending";
  if (["rejected", "cancelled"].includes(payment.status)) return "refused";
  return "review";
}

function olderSnapshot(previous: PaymentRecord, payment: ProviderPayment, kind: ReturnType<typeof paymentKind>) {
  if (payment.updatedAt < previous.provider_updated_at || payment.refunded < previous.refunded_amount) return true;
  if (previous.refund_state === "confirmed" && kind !== "refunded") return true;
  if (payment.updatedAt !== previous.provider_updated_at) return false;
  return (previous.refund_state === "review" && kind !== "refunded")
    || (previous.provider_status === "approved" && (kind === "pending" || kind === "refused"));
}

function decidePayment(order: Checkout, previous: PaymentRecord | null, payment: ProviderPayment, now: number) {
  const kind = paymentKind(payment);
  const canFulfill = reserved(order, now) && payment.approvedAt !== null
    && payment.approvedAt >= order.created_at - minute && payment.approvedAt < order.expires_at && payment.approvedAt <= now + minute;
  const monetary = kind === "approved" || kind === "refunded" || kind === "review";
  const primary = order.primary_payment_id ?? (monetary ? payment.id : null);
  const extra = primary !== null && primary !== payment.id;
  let financial = order.payment;
  let stage = order.stage;
  let refund: RefundState = previous?.refund_state ?? "none";
  let outcome = `provider_${kind}`;

  if (kind === "refunded" || kind === "review") {
    refund = kind === "refunded" ? "confirmed" : "review";
    if (!extra) {
      financial = kind === "refunded" ? "reembolsado" : "em_revisao";
      if (stage !== "retirado") stage = "cancelado";
    }
  } else if (kind === "approved") {
    if (extra || refund === "requested" || (refund === "review" && stage === "cancelado")
      || (!order.primary_payment_id && !canFulfill)) {
      refund = "requested";
      if (!extra) {
        financial = "estorno_solicitado";
        if (stage !== "retirado") stage = "cancelado";
      }
      outcome = extra ? "duplicate_payment_refund_requested" : "unfulfillable_payment_refund_requested";
    } else if (!order.primary_payment_id && canFulfill) {
      financial = "aprovado";
      stage = "recebido";
      outcome = "payment_verified";
    } else if (!extra && refund === "review" && stage === "retirado") {
      refund = "none";
      financial = "aprovado";
      outcome = "payment_review_cleared";
    }
  } else if (!order.primary_payment_id && kind === "refused" && reserved(order, now)) {
    // Refused attempts can be retried in the same preference until the reservation expires.
    financial = "recusado";
  } else if (!extra && order.payment === "aprovado") {
    financial = "em_revisao";
    refund = "review";
    if (stage !== "retirado") stage = "cancelado";
    outcome = "payment_reversal_review";
  }

  return { primary, financial, stage, refund, outcome };
}

const orderAuditLabels: Partial<Record<Payment, string>> = {
  aprovado: "Pagamento confirmado pelo Mercado Pago",
  recusado: "Pagamento recusado pelo Mercado Pago",
  estorno_solicitado: "Pedido cancelado · estorno solicitado",
  reembolsado: "Estorno confirmado pelo Mercado Pago",
  em_revisao: "Pagamento em revisão",
};

async function applyPayment(db: D1Database, config: MercadoPagoConfig, payment: ProviderPayment, event: Event) {
  const reference = payment.externalReference;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reference)) {
    await audit(db, event, "unrelated_payment").run();
    return;
  }
  let verifiedPreference: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const order = await checkoutFor(db, reference, config.mode);
    if (!order) {
      await audit(db, event, "unrelated_payment").run();
      return;
    }
    const entry = { ...event, order: event.order ?? order.id, snapshot: payment };
    if ((event.order && event.order !== order.id) || !matches(config, order, payment)) {
      await audit(db, entry, "payment_mismatch").run();
      return;
    }
    const previous = await db.prepare("SELECT * FROM payment_records WHERE mode=? AND payment_id=?")
      .bind(config.mode, payment.id).first<PaymentRecord>();
    if (previous && previous.order_id !== order.id) {
      await audit(db, entry, "payment_mismatch").run();
      return;
    }
    const kind = paymentKind(payment);
    if (!previous && payment.status === "approved" && !payment.detail) {
      throw new Problem(503, "O Mercado Pago ainda não informou o detalhe da aprovação.");
    }
    if (previous && olderSnapshot(previous, payment, kind)) {
      await audit(db, entry, "stale_snapshot").run();
      return;
    }
    if (previous && previous.provider_updated_at === payment.updatedAt && previous.provider_status === payment.status
      && previous.provider_detail === payment.detail && previous.refunded_amount === payment.refunded) {
      await audit(db, entry, "unchanged_snapshot").run();
      return;
    }
    if (!previous) {
      // Recover even after expiration. The verified preference can be needed to refund a late payment.
      const expected = order.preference_id ?? await recoverRecordedPreference(db, config, order);
      if (!expected) throw new Problem(503, "A preferência ainda precisa ser conciliada.");
      if (expected !== verifiedPreference) {
        if (!await verifyPaymentPreference(config, payment, expected)) {
          await audit(db, entry, "preference_mismatch").run();
          return;
        }
        verifiedPreference = expected;
      }
    }

    const now = Date.now();
    const result = decidePayment(order, previous, payment, now);
    const write = crypto.randomUUID();
    const refundKey = result.refund === "requested" ? previous?.refund_key ?? crypto.randomUUID() : null;
    const changedOrder = result.stage !== order.stage || result.financial !== order.payment;
    const accepting = order.stage === "aguardando_pagamento" && result.stage === "recebido";
    const [claim] = await db.batch([
      // The SQL deadline closes the race against another reservation taking
      // the released capacity while a provider response is being verified.
      db.prepare(`UPDATE payment_checkouts SET version=version+1, write_id=?, primary_payment_id=?
        WHERE order_id=? AND version=? AND EXISTS
        (SELECT 1 FROM orders WHERE id=? AND stage=? AND payment=? AND expires_at IS ?
          AND (?=0 OR (expires_at>unixepoch('subsec')*1000 AND slot>unixepoch('subsec')*1000)))
        AND NOT EXISTS (SELECT 1 FROM payment_records WHERE mode=? AND payment_id=? AND order_id<>?)`)
        .bind(write, result.primary, order.id, order.version, order.id, order.stage, order.payment, order.expires_at,
          Number(accepting), config.mode, payment.id, order.id),
      db.prepare(`INSERT INTO payment_records (mode,payment_id,order_id,provider_status,provider_detail,provider_updated_at,
          approved_at,amount,refunded_amount,refund_state,refund_key)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${writeGuard}
        ON CONFLICT(mode,payment_id) DO UPDATE SET provider_status=excluded.provider_status,
          provider_detail=excluded.provider_detail, provider_updated_at=excluded.provider_updated_at,
          approved_at=COALESCE(excluded.approved_at,payment_records.approved_at), refunded_amount=excluded.refunded_amount,
          refund_state=excluded.refund_state, refund_key=COALESCE(payment_records.refund_key,excluded.refund_key)
        WHERE payment_records.order_id=excluded.order_id`)
        .bind(config.mode, payment.id, order.id, payment.status, payment.detail, payment.updatedAt, payment.approvedAt,
          payment.amount, payment.refunded, result.refund, refundKey, order.id, write),
      db.prepare(`UPDATE orders SET payment=?,stage=?,events=json_insert(events,'$[#]',json(?))
        WHERE id=? AND ? AND ${writeGuard}`).bind(result.financial, result.stage,
          JSON.stringify({ label: orderAuditLabels[result.financial] ?? "Conciliação de pagamento", at: now }),
          order.id, Number(changedOrder), order.id, write),
      audit(db, { ...entry, from: order.payment, to: result.financial }, result.outcome, write),
    ]);
    if (claim.meta.changes) return;
  }
  throw new Problem(503, "O pedido mudou durante a conciliação. Tente novamente.");
}

async function recoverRecordedPreference(db: D1Database, config: MercadoPagoConfig, order: Checkout) {
  if (!order.preference_started_at || Date.now() - order.preference_started_at < providerCallGrace) return null;
  const preference = await recoverPreference(config, order);
  if (!preference) return null;
  const result = await db.prepare(`UPDATE payment_checkouts SET preference_id=?,checkout_url=?,preference_state='ready'
    WHERE order_id=? AND preference_state IN ('started','unknown')`)
    .bind(preference.id, preference.url, order.id).run();
  if (result.meta.changes) await audit(db, eventFor(config, "checkout", order.id), "preference_recovered").run();
  return (await checkoutFor(db, order.id, config.mode))?.preference_id ?? null;
}

async function readAndApply(db: D1Database, config: MercadoPagoConfig, id: string, event: Event) {
  try {
    const snapshot = await getPayment(config, id);
    await applyPayment(db, config, snapshot, event);
    return snapshot;
  } catch (error) {
    if (event.source === "webhook") await audit(db, event, "retry").run();
    throw error;
  }
}

export async function paymentNotice(db: D1Database, mode: MercadoPagoMode, request: Request) {
  // Keep reconciling payments from an earlier mode when its credentials remain configured.
  const config = providerConfig(mode);
  const notice = await verifyPaymentNotice(config, request);
  if (!acceptsPaymentTopic(request)) return { received: true };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${mode}:${notice.signature}`));
  const event: Event = {
    id: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    mode, source: "webhook", payment: notice.id, request: notice.requestId,
  };
  await audit(db, event, "queued").run();
  const recorded = await db.prepare("SELECT outcome FROM payment_events WHERE id=?").bind(event.id).first<string>("outcome");
  if (recorded === "queued" || recorded === "retry") await readAndApply(db, config, notice.id, event);
  return { received: true };
}

export async function cancelPaidCheckout(db: D1Database, config: MercadoPagoConfig, id: string, actor: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const order = await checkoutFor(db, id, config.mode);
    if (!order) throw new Problem(404, "Pedido não encontrado.");
    verifyCollector(order, config);
    if (order.stage === "cancelado") return { ok: true };
    if (!["aguardando_pagamento", "recebido", "em_preparo", "pronto"].includes(order.stage)) {
      throw new Problem(409, "Esse pedido não pode ser cancelado pelo painel.");
    }
    const refund = order.payment === "aprovado" ? order.primary_payment_id : null;
    if (order.payment === "aprovado" && !refund) throw new Problem(409, "Confira a transação no Mercado Pago antes de cancelar.");
    const now = Date.now();
    const write = crypto.randomUUID();
    const entry = { ...eventFor(config, "operator", id, refund ?? undefined), actor,
      from: order.payment, to: refund ? "estorno_solicitado" as const : order.payment };
    const [claim] = await db.batch([
      db.prepare(`UPDATE payment_checkouts SET version=version+1,write_id=?,next_check_at=?
        WHERE order_id=? AND version=? AND EXISTS (SELECT 1 FROM orders WHERE id=? AND stage=? AND payment=?)`)
        .bind(write, now, id, order.version, id, order.stage, order.payment),
      db.prepare(`UPDATE orders SET stage='cancelado',payment=?,events=json_insert(events,'$[#]',json(?)) WHERE id=? AND ${writeGuard}`)
        .bind(refund ? "estorno_solicitado" : order.payment,
          JSON.stringify({ label: refund ? orderAuditLabels.estorno_solicitado : "Pedido cancelado pela operação", at: now }), id, id, write),
      db.prepare(`UPDATE payment_records SET refund_state='requested',refund_key=COALESCE(refund_key,?)
        WHERE mode=? AND payment_id=? AND order_id=? AND refund_state='none' AND ${writeGuard}`)
        .bind(crypto.randomUUID(), config.mode, refund, id, id, write),
      audit(db, entry, refund ? "refund_requested_by_operator" : "order_cancelled_by_operator", write),
    ]);
    if (claim.meta.changes) return { ok: true };
  }
  throw new Problem(409, "O pedido mudou. Atualize a fila.");
}

async function reconcileRefund(db: D1Database, config: MercadoPagoConfig, row: PaymentRecord, canRefund: boolean) {
  const now = Date.now();
  const event = eventFor(config, "refund", row.order_id, row.payment_id);
  const claimed = await db.prepare(`UPDATE payment_records SET refund_attempted_at=?
    WHERE mode=? AND payment_id=? AND refund_state='requested' AND (refund_attempted_at IS NULL OR refund_attempted_at<=?)`)
    .bind(now, config.mode, row.payment_id, now - minute).run();
  if (!claimed.meta.changes) return;
  try {
    const order = await checkoutFor(db, row.order_id, config.mode);
    if (!order) throw new Problem(503, "Pedido indisponível para conciliação.");
    const snapshot = await readAndApply(db, config, row.payment_id, eventFor(config, "reconciliation", row.order_id, row.payment_id));
    if (!matches(config, order, snapshot) || paymentKind(snapshot) !== "approved" || !canRefund) return;
    const current = await db.prepare("SELECT * FROM payment_records WHERE mode=? AND payment_id=?")
      .bind(config.mode, row.payment_id).first<PaymentRecord>();
    if (!current || current.refund_state !== "requested" || current.refund_id
      || snapshot.updatedAt < current.provider_updated_at || current.refunded_amount !== 0) return;
    if (!current.refund_key) throw new Problem(503, "Solicitação de estorno incompleta.");
    // The provider supports idempotency for refunds. Persist a receipt, then
    // wait for an authoritative payment lookup to show the full refund.
    const refundId = await requestFullRefund(config, row.payment_id, current.refund_key);
    await db.batch([
      db.prepare("UPDATE payment_records SET refund_id=COALESCE(refund_id,?) WHERE mode=? AND payment_id=?")
        .bind(refundId, config.mode, row.payment_id),
      audit(db, event, "refund_submitted"),
    ]);
  } catch (error) {
    await audit(db, event, "refund_retry_required").run();
    throw error;
  }
}

async function reconcileCheckout(db: D1Database, config: MercadoPagoConfig, order: Checkout, now: number) {
  const age = now - order.created_at;
  const next = now + (reserved(order, now) ? minute : age < 60 * minute ? 5 * minute : age < 24 * 60 * minute ? 60 * minute : 24 * 60 * minute);
  const claim = await db.prepare("UPDATE payment_checkouts SET next_check_at=? WHERE order_id=? AND next_check_at=?")
    .bind(next, order.id, order.next_check_at).run();
  if (!claim.meta.changes) return;
  try {
    verifyCollector(order, config);
    if (reserved(order, now) && order.preference_state !== "ready") await checkoutPaymentLink(db, config, order.id, false);
    const found = await searchPayments(config, order.id, order.search_offset, 4);
    await Promise.all(found.ids.map(id => readAndApply(db, config, id, eventFor(config, "reconciliation", order.id, id))));
    await db.prepare(`UPDATE payment_checkouts SET search_offset=?,last_check_result='ok',next_check_at=?
      WHERE order_id=? AND next_check_at=?`).bind(found.nextOffset, found.nextOffset ? now + minute : next, order.id, next).run();
  } catch (error) {
    await db.batch([
      db.prepare(`UPDATE payment_checkouts SET last_check_result='retry',next_check_at=? WHERE order_id=? AND next_check_at=?`)
        .bind(now + minute, order.id, next),
      audit(db, eventFor(config, "reconciliation", order.id), "search_retry"),
    ]);
    throw error;
  }
}

export async function runReconciliation(db: D1Database, mode: Mode = checkoutMode(), onlyOrder?: string) {
  if (mode === "demo") throw new Problem(409, "A conciliação do Mercado Pago fica disponível fora do modo DEMO.");
  const config = providerConfig(mode);
  const now = Date.now();
  const cutoff = now - reconcileLookback;
  const [notices, checkouts, refunds] = await db.batch([
    db.prepare(`SELECT id,payment_id FROM payment_events WHERE mode=? AND source='webhook'
      AND outcome IN ('queued','retry') AND updated_at<=? AND created_at>=? AND ? IS NULL ORDER BY updated_at LIMIT 2`)
      .bind(mode, now - minute, cutoff, onlyOrder ?? null),
    db.prepare(`${orderCheckout} WHERE o.mode=? ${onlyOrder ? "AND o.id=?" : "AND c.next_check_at<=? AND o.created_at>=?"}
      AND c.preference_started_at IS NOT NULL ORDER BY (o.stage='aguardando_pagamento') DESC, c.next_check_at LIMIT 3`)
      .bind(mode, ...(onlyOrder ? [onlyOrder] : [now, cutoff])),
    db.prepare(`SELECT * FROM payment_records WHERE mode=? AND refund_state='requested'
      AND (refund_attempted_at IS NULL OR refund_attempted_at<=?) AND (? IS NULL OR order_id=?)
      ORDER BY refund_attempted_at LIMIT 2`).bind(mode, now - minute, onlyOrder ?? null, onlyOrder ?? null),
  ]);
  // Keep authorized refunds running when only new checkouts are suspended.
  const canRefund = mode === "teste" || productionAuthorized();
  const jobs = [
    ...(notices.results as { id: string; payment_id: string }[]).map(row =>
      readAndApply(db, config, row.payment_id, { id: row.id, mode, source: "webhook", payment: row.payment_id })),
    ...(checkouts.results as Checkout[]).map(order => reconcileCheckout(db, config, order, now)),
    ...(refunds.results as PaymentRecord[]).map(row => reconcileRefund(db, config, row, canRefund)),
  ];
  const results = await Promise.allSettled(jobs);
  if (results.some(result => result.status === "rejected")) throw new Problem(503, "A conciliação ficou incompleta. As pendências foram preservadas para outra tentativa.");
  return { checked: results.length };
}

export async function paymentSummary(db: D1Database, mode: MercadoPagoMode) {
  const cutoff = Date.now() - 24 * 60 * minute;
  const [counts, problems] = await db.batch([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM payment_records WHERE mode=? AND refund_state='requested') AS refunds,
      (SELECT COUNT(*) FROM payment_records WHERE mode=? AND refund_state='review') AS reviews,
      (SELECT COUNT(*) FROM payment_checkouts c JOIN orders o ON o.id=c.order_id
        WHERE o.mode=? AND (c.last_check_result='retry' OR c.preference_state IN ('unknown','blocked'))
        AND o.created_at>=?) AS interruptions,
      (SELECT COUNT(*) FROM payment_events WHERE mode=? AND outcome IN ('payment_mismatch','preference_mismatch','seller_verification_failed')
        AND created_at>=?) AS mismatches`)
      .bind(mode, mode, mode, cutoff, mode, cutoff),
    db.prepare(`SELECT order_id AS orderId, payment_id AS paymentId, refund_state AS state FROM payment_records
      WHERE mode=? AND refund_state IN ('requested','review')
      ORDER BY (refund_state='review') DESC, provider_updated_at DESC LIMIT 12`).bind(mode),
  ]);
  const totals = counts.results[0] as { refunds: number; reviews: number; interruptions: number; mismatches: number };
  return { ...totals, problems: problems.results as { orderId: string; paymentId: string; state: "requested" | "review" }[] };
}
