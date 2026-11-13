import { originalProducts, type CartLine, type Order } from "./federal";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, body?: Record<string, unknown> | File, signal?: AbortSignal): Promise<T> {
  const headers = body ? { "Content-Type": body instanceof File ? body.type : "application/json" } : undefined;
  const response = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET", cache: "no-store", headers, signal,
    body: body instanceof File ? body : body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new ApiError(response.status, result?.error ?? "A conexão com a Kombi falhou. Tente novamente.");
  if (result === null) throw new Error("A conexão com a Kombi falhou. Tente novamente.");
  return result as T;
}

export const errorMessage = (error: unknown) => error instanceof Error && error.name !== "TypeError"
  ? error.message : "A conexão com a Kombi falhou. Tente novamente.";

export function readLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; } catch { return fallback; }
}

export function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Browser storage may be disabled. */ }
}

export function readCart(key: string): CartLine[] {
  const cart = readLocal<unknown>(key, []);
  if (!Array.isArray(cart)) return [];
  return cart.filter((line): line is CartLine => line && typeof line.key === "string" && typeof line.product === "string"
    && originalProducts.some(p => p.id === line.product)
    && typeof line.variant === "string" && typeof line.press === "string" && typeof line.note === "string"
    && Array.isArray(line.extras) && line.extras.every((extra: unknown) => typeof extra === "string")
    && Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= 15).slice(0, 30);
}

export type RememberedOrder = { tracking: string; id: string; created_at: number };
export function rememberedOrders(): RememberedOrder[] {
  const list = readLocal<unknown>("federal-pedidos", []);
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is RememberedOrder => item && typeof item.tracking === "string"
    && /^[a-f0-9]{32}$/.test(item.tracking) && typeof item.id === "string" && Number.isFinite(item.created_at));
}
export function rememberOrder(order: Order) {
  if (!order.tracking) return;
  const list = rememberedOrders();
  const record = { tracking: order.tracking, id: order.id, created_at: order.created_at };
  writeLocal("federal-pedidos", [record, ...list.filter(item => item.tracking !== record.tracking)].slice(0, 25));
}

export function captureCampaign() {
  try {
    const campaign = new URLSearchParams(location.search).get("utm_campaign");
    if (campaign && /^[a-zA-Z0-9_-]{1,64}$/.test(campaign)) sessionStorage.setItem("federal-campanha", campaign);
    return sessionStorage.getItem("federal-campanha");
  } catch { return null; }
}
