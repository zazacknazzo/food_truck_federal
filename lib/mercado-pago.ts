import { Problem, type MercadoPagoConfig } from "./federal-runtime";

const apiOrigin = "https://api.mercadopago.com";
const identityOrigin = "https://api.mercadolibre.com";
const encoder = new TextEncoder();
export const currency = "BRL";
const checkoutHosts = new Set(["www.mercadopago.com.br", "www.mercadopago.com"]);

type ProviderObject = Record<string, unknown>;

export class MercadoPagoError extends Error {
  constructor(public status: number | null) { super("Falha de comunicação com o Mercado Pago."); }
}

export function providerId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) ? value : null;
}

function preferenceId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : null;
}

function cents(value: unknown) {
  const money = typeof value === "number" ? String(value) : value;
  if (typeof money !== "string" || !/^\d{1,9}(?:\.\d{1,2})?$/.test(money)) return null;
  const [whole, decimal = ""] = money.split(".");
  return Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
}

function asObject(value: unknown): ProviderObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ProviderObject : null;
}

async function mp(config: MercadoPagoConfig, path: string, payload?: ProviderObject, requestKey?: string) {
  try {
    const origin = path === "/users/me" ? identityOrigin : apiOrigin;
    const response = await fetch(origin + path, {
      method: payload ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json" } : {}),
        ...(requestKey ? { "X-Idempotency-Key": requestKey } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new MercadoPagoError(response.status);
    const parsed = asObject(await response.json());
    if (!parsed) throw new MercadoPagoError(null);
    return parsed;
  } catch (error) {
    // Keep provider payloads, tokens and payer details out of logs and responses.
    if (error instanceof MercadoPagoError) throw error;
    throw new MercadoPagoError(null);
  }
}

export async function verifySeller(config: MercadoPagoConfig) {
  const seller = await mp(config, "/users/me");
  if (providerId(seller.id) !== config.collectorId || !Array.isArray(seller.tags)
    || seller.tags.includes("test_user") !== (config.mode === "teste")) throw new MercadoPagoError(403);
}

type PreferenceOrder = { id: string; tracking: string; total: number; created_at: number; expires_at: number };
type Preference = { id: string; url: string };

function validatePreference(config: MercadoPagoConfig, raw: ProviderObject, order: PreferenceOrder): Preference {
  const id = preferenceId(raw.id);
  const item = Array.isArray(raw.items) && raw.items.length === 1 ? asObject(raw.items[0]) : null;
  if (!id || providerId(raw.collector_id) !== config.collectorId || raw.external_reference !== order.id
    || !item || item.id !== order.id || item.currency_id !== currency || item.quantity !== 1
    || cents(item.unit_price) !== order.total) throw new MercadoPagoError(null);

  try {
    // Checkout Pro also uses init_point with a verified test seller.
    const target = raw.init_point;
    if (typeof target !== "string") throw new Error();
    const url = new URL(target);
    if (url.protocol !== "https:" || !checkoutHosts.has(url.hostname) || url.port || url.username || url.password
      || !url.pathname.includes("/checkout/") || url.searchParams.get("pref_id") !== id) throw new Error();
    return { id, url: url.toString() };
  } catch { throw new MercadoPagoError(null); }
}

export async function createPreference(config: MercadoPagoConfig, order: PreferenceOrder) {
  const tracking = `${config.origin}/pedido/${order.tracking}`;
  const callback = (result: string) => `${tracking}?retorno=${result}`;
  const body = {
    items: [{ id: order.id, title: "Food Truck Federal · Pedido para retirada", currency_id: currency, quantity: 1, unit_price: order.total / 100 }],
    external_reference: order.id,
    back_urls: { success: callback("aprovado"), pending: callback("pendente"), failure: callback("recusado") },
    auto_return: "approved",
    notification_url: `${config.origin}/api/mercado-pago/webhook/${config.mode}`,
    expires: true,
    expiration_date_from: new Date(order.created_at).toISOString(),
    expiration_date_to: new Date(order.expires_at).toISOString(),
    payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }], installments: 1 },
  };
  return validatePreference(config, await mp(config, "/checkout/preferences", body, order.id), order);
}

export async function recoverPreference(config: MercadoPagoConfig, order: PreferenceOrder) {
  const query = new URLSearchParams({ external_reference: order.id, limit: "10" });
  const raw = await mp(config, `/checkout/preferences/search?${query}`);
  if (!Array.isArray(raw.elements)) throw new MercadoPagoError(null);
  if (raw.elements.length === 0) return null;
  if (raw.elements.length !== 1 || Number(raw.total ?? raw.elements.length) > 1) throw new MercadoPagoError(null);
  const id = preferenceId(asObject(raw.elements[0])?.id);
  if (!id) throw new MercadoPagoError(null);
  return validatePreference(config, await mp(config, `/checkout/preferences/${encodeURIComponent(id)}`), order);
}

export type ProviderPayment = {
  id: string; merchantOrder: string | null; collector: string; externalReference: string;
  currency: string; amount: number; refunded: number; status: string; detail: string;
  updatedAt: number; approvedAt: number | null; live: boolean;
};

export async function getPayment(config: MercadoPagoConfig, id: string): Promise<ProviderPayment> {
  if (!providerId(id)) throw new MercadoPagoError(null);
  const raw = await mp(config, `/v1/payments/${id}`);
  const collector = providerId(raw.collector_id);
  const amount = cents(raw.transaction_amount);
  const refunded = cents(raw.transaction_amount_refunded);
  const updatedAt = typeof raw.date_last_updated === "string" ? Date.parse(raw.date_last_updated) : NaN;
  const approvedAt = typeof raw.date_approved === "string" ? Date.parse(raw.date_approved) : NaN;
  if (providerId(raw.id) !== id || !collector || typeof raw.currency_id !== "string" || amount === null || refunded === null
    || refunded > amount || typeof raw.live_mode !== "boolean" || typeof raw.status !== "string" || !/^[a-z_]{1,35}$/.test(raw.status)
    || !Number.isFinite(updatedAt)) throw new MercadoPagoError(null);
  return {
    id, merchantOrder: providerId(asObject(raw.order)?.id), collector,
    externalReference: typeof raw.external_reference === "string" ? raw.external_reference : "",
    currency: raw.currency_id, amount, refunded, status: raw.status,
    detail: typeof raw.status_detail === "string" && /^[a-z0-9_]{1,80}$/.test(raw.status_detail) ? raw.status_detail : "",
    updatedAt, approvedAt: Number.isFinite(approvedAt) ? approvedAt : null, live: raw.live_mode,
  };
}

export function acceptsPaymentTopic(request: Request) {
  const params = new URL(request.url).searchParams;
  const topic = params.get("type") ?? params.get("topic");
  return topic === null || topic === "payment" || topic === "payments";
}

export async function verifyPaymentPreference(config: MercadoPagoConfig, payment: ProviderPayment, expectedPreference: string) {
  if (!payment.merchantOrder) throw new MercadoPagoError(null);
  const raw = await mp(config, `/merchant_orders/${payment.merchantOrder}`);
  if (!Array.isArray(raw.payments) || !raw.payments.some(item => providerId(asObject(item)?.id) === payment.id)) {
    throw new MercadoPagoError(null); // The merchant order can lag behind the payment.
  }
  return providerId(raw.id) === payment.merchantOrder && raw.preference_id === expectedPreference
    && raw.external_reference === payment.externalReference && providerId(asObject(raw.collector)?.id) === config.collectorId;
}

export async function searchPayments(config: MercadoPagoConfig, reference: string, offset: number, limit: number) {
  const query = new URLSearchParams({ external_reference: reference, sort: "id", criteria: "asc", offset: String(offset), limit: String(limit) });
  const raw = await mp(config, `/v1/payments/search?${query}`);
  const total = asObject(raw.paging)?.total;
  if (!Array.isArray(raw.results) || raw.results.length > limit || !Number.isSafeInteger(total) || Number(total) < 0) throw new MercadoPagoError(null);
  const ids = raw.results.map(row => providerId(asObject(row)?.id));
  if (ids.some(id => id === null)) throw new MercadoPagoError(null);
  const next = offset + raw.results.length;
  return { ids: [...new Set(ids as string[])], nextOffset: next < Math.min(Number(total), 10_000) && raw.results.length > 0 ? next : 0 };
}

export async function requestFullRefund(config: MercadoPagoConfig, paymentId: string, key: string) {
  if (!providerId(paymentId)) throw new MercadoPagoError(null);
  const result = await mp(config, `/v1/payments/${paymentId}/refunds`, {}, key);
  const id = providerId(result.id);
  if (!id || providerId(result.payment_id) !== paymentId) throw new MercadoPagoError(null);
  return id;
}

export async function verifyPaymentNotice(config: MercadoPagoConfig, request: Request) {
  const url = new URL(request.url);
  const ids = url.searchParams.getAll("data.id");
  const id = ids.length === 1 ? providerId(ids[0]) : null;
  const requestId = request.headers.get("x-request-id") ?? "";
  const parts = (request.headers.get("x-signature") ?? "").split(",").map(part => part.trim());
  const timestamps = parts.filter(part => part.startsWith("ts=")).map(part => part.slice(3));
  const signatures = parts.filter(part => part.startsWith("v1=")).map(part => part.slice(3));
  const ts = timestamps[0];
  const signature = signatures[0];
  if (url.protocol !== "https:" || url.origin !== config.origin || !id || !/^[\w.-]{1,128}$/.test(requestId)
    || timestamps.length !== 1 || signatures.length !== 1 || !/^\d{10}(?:\d{3})?$/.test(ts)
    || !/^[a-f0-9]{64}$/i.test(signature)) throw new Problem(401, "Assinatura de notificação inválida.");
  const timestamp = ts.length === 10 ? Number(ts) * 1000 : Number(ts);
  // Valid delayed deliveries are safe to replay: each receipt is deduplicated
  // and only a fresh, authenticated provider lookup can change a payment.
  if (timestamp > Date.now() + 5 * 60_000) throw new Problem(401, "Assinatura de notificação inválida.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(config.webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const manifest = encoder.encode(`id:${id};request-id:${requestId};ts:${ts};`);
  const hash = Uint8Array.from(signature.match(/../g)!, byte => Number.parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, hash, manifest)) throw new Problem(401, "Assinatura de notificação inválida.");
  return { id, requestId, signature: signature.toLowerCase() };
}
