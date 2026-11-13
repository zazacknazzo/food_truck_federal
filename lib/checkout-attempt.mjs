/**
 * @typedef {{
 *   customer: string,
 *   method: import("./federal").Method,
 *   scenario: import("./federal").Scenario,
 *   pickup: import("./federal").Pickup,
 *   slot: number | null,
 *   items: import("./federal").CartLine[],
 *   total: number,
 *   campaign: string | null,
 * }} CheckoutDraft
 * @typedef {CheckoutDraft & { requestKey: string }} CheckoutRequest
 */

const storageKey = "federal-checkout-attempt-v1";

/** @type {CheckoutRequest | null} */
let unfinished = null;

/** @returns {CheckoutRequest | null} */
function readAttempt() {
  if (unfinished) return unfinished;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (saved && typeof saved.requestKey === "string" && typeof saved.customer === "string"
      && (saved.method === "Pix" || saved.method === "Cartão")
      && ["aprovado", "pendente", "recusado", "expirado"].includes(saved.scenario)
      && ["imediata", "agendada"].includes(saved.pickup)
      && (saved.pickup === "imediata" ? saved.slot === null : Number.isSafeInteger(saved.slot))
      && Array.isArray(saved.items) && Number.isSafeInteger(saved.total)) return saved;
  } catch {
    // Checkout also works in browsers that block session storage.
  }
  return null;
}

/** @param {CheckoutDraft["items"]} items */
export function pendingCheckoutAttempt(items) {
  const saved = readAttempt();
  return saved && JSON.stringify(saved.items) === JSON.stringify(items) ? saved : null;
}

/** @param {CheckoutDraft} draft */
export function startCheckoutAttempt(draft) {
  const request = { ...draft, requestKey: crypto.randomUUID() };
  unfinished = request;
  // Keep the original request available after a reload or an uncertain response.
  try { sessionStorage.setItem(storageKey, JSON.stringify(request)); } catch {}
  return request;
}

/** @param {string} key */
export function finishCheckoutAttempt(key) {
  if (readAttempt()?.requestKey !== key) return;
  unfinished = null;
  try { sessionStorage.removeItem(storageKey); } catch {}
}
