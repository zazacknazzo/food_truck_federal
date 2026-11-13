import { env } from "cloudflare:workers";
import { commercialInfoReady, type Config, type MercadoPagoMode, type Mode } from "./federal";

export class Problem extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type MercadoPagoConfig = {
  mode: MercadoPagoMode;
  token: string;
  webhookSecret: string;
  collectorId: string;
  origin: string;
};
const reconcileSecretPattern = /^[\w.-]{32,256}$/;

export function productionAuthorized() {
  return env.FEDERAL_PRODUCTION_APPROVAL === "HOMOLOGADO_E_AUTORIZADO";
}

export function checkoutMode(): Mode {
  switch (env.FEDERAL_MODE) {
    case undefined: case "": case "demo": return "demo";
    case "teste": return "teste";
    case "producao": return productionAuthorized() ? "producao" : "demo";
    default: throw new Problem(503, "A configuração do checkout precisa ser revisada.");
  }
}

export function providerConfig(mode: MercadoPagoMode): MercadoPagoConfig {
  const production = mode === "producao";
  const token = production ? env.FEDERAL_MP_PROD_ACCESS_TOKEN : env.FEDERAL_MP_TEST_ACCESS_TOKEN;
  const webhookSecret = production ? env.FEDERAL_MP_PROD_WEBHOOK_SECRET : env.FEDERAL_MP_TEST_WEBHOOK_SECRET;
  const collectorId = production ? env.FEDERAL_MP_PROD_COLLECTOR_ID : env.FEDERAL_MP_TEST_COLLECTOR_ID;
  const otherCollector = production ? env.FEDERAL_MP_TEST_COLLECTOR_ID : env.FEDERAL_MP_PROD_COLLECTOR_ID;
  const otherToken = production ? env.FEDERAL_MP_TEST_ACCESS_TOKEN : env.FEDERAL_MP_PROD_ACCESS_TOKEN;
  let origin: URL | undefined;
  try { origin = new URL(env.FEDERAL_PUBLIC_ORIGIN ?? ""); } catch { /* Incomplete configuration. */ }
  if (!token || !webhookSecret || !collectorId || !/^[1-9][0-9]{0,18}$/.test(collectorId)
    || collectorId === otherCollector || token === otherToken
    || !origin || origin.protocol !== "https:" || origin.origin !== env.FEDERAL_PUBLIC_ORIGIN
    || /^(localhost|127\.|\[)/.test(origin.hostname)) {
    throw new Problem(503, "O Mercado Pago ainda não está configurado para este ambiente.");
  }
  return { mode, token, webhookSecret, collectorId, origin: origin.origin };
}

export function readyForCheckout(mode: Mode, config: Config) {
  if (mode === "demo") return true;
  try { providerConfig(mode); } catch { return false; }
  return mode !== "producao" || commercialInfoReady(config.commercial)
    && reconcileSecretPattern.test(env.FEDERAL_RECONCILIATION_SECRET ?? "");
}

export function signedInId(headers: Headers) {
  return headers.get("oai-authenticated-user-id")?.trim() || "";
}

export async function assertReconciliationKey(headers: Headers) {
  const secret = env.FEDERAL_RECONCILIATION_SECRET;
  const candidate = headers.get("authorization")?.match(/^Bearer ([\w.-]{32,256})$/i)?.[1];
  if (!secret || !candidate || !reconcileSecretPattern.test(secret)) throw new Problem(403, "Conciliação restrita.");
  const encoder = new TextEncoder();
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("raw", encoder.encode(candidate), algorithm, false, ["sign"]);
  const expected = await crypto.subtle.importKey("raw", encoder.encode(secret), algorithm, false, ["verify"]);
  const message = encoder.encode("federal-reconciliation");
  const signature = await crypto.subtle.sign("HMAC", key, message);
  if (!await crypto.subtle.verify("HMAC", expected, signature, message)) throw new Problem(403, "Conciliação restrita.");
}
