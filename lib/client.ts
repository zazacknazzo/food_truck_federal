import type { Order } from "./federal";

export async function api<T>(path: string, body?: Record<string, unknown> | File, signal?: AbortSignal): Promise<T> {
  const headers = body ? { "Content-Type": body instanceof File ? body.type : "application/json" } : undefined;
  const response = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET", cache: "no-store", headers, signal,
    body: body instanceof File ? body : body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? "A conexão com a Kombi falhou. Tente novamente.");
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

export type RememberedOrder = { tracking: string; id: string; created_at: number };
export function rememberOrder(order: Order) {
  if (!order.tracking) return;
  const list = readLocal<RememberedOrder[]>("federal-pedidos", []);
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
