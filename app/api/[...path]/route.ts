import {
  adminState, createOrder, database, expireOrders, getCheckoutLink, getOrder, getPublishedSubmissions, isOperator,
  moveOrder, pauseOperation, publicStore, readBoundedBody, readPhoto, resolvePayment, storeContext, upcomingSlots,
  updateCommercialInfo, updateOperation, updateProduct, updateSubmission, uploadPhoto,
} from "@/lib/federal-server";
import { assertReconciliationKey, checkoutMode, Problem, readyForCheckout, signedInId } from "@/lib/federal-runtime";
import { paymentNotice, runReconciliation } from "@/lib/federal-payments";
import type { Mode } from "@/lib/federal";

export const dynamic = "force-dynamic";

function json(value: unknown, status = 200, mode?: Mode) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
    ...(mode ? { "X-Federal-Mode": mode } : {}), "X-Content-Type-Options": "nosniff" } });
}

async function bodyOf(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Problem(415, "Envie uma solicitação JSON.");
  const raw = await readBoundedBody(request, 60_000, "Solicitação grande demais.");
  try {
    const body = JSON.parse(new TextDecoder().decode(raw));
    if (body === null || Array.isArray(body) || typeof body !== "object") throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new Problem(400, "Confira os dados informados.");
  }
}

async function route(request: Request, path: string[]) {
  const [resource, action, item] = path;
  const get = request.method === "GET";
  if (path.length > 3) throw new Problem(404, "Recurso não encontrado.");
  if (!get && resource === "mercado-pago" && action === "webhook" && (item === "teste" || item === "producao")) {
    return json(await paymentNotice(database(), item, request), 200, item);
  }
  const origin = request.headers.get("origin");
  if (!get && (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== new URL(request.url).origin))) {
    throw new Problem(403, "Abra o formulário no site da Kombi.");
  }
  if (resource === "admin" && !isOperator(request.headers)) throw new Problem(403, "Entre com uma conta autorizada para operar o painel.");

  if (get && resource === "loja" && !action) {
    const state = await publicStore();
    return json(state, 200, state.mode);
  }
  if (get && resource === "horarios" && !action) {
    const { config } = await storeContext();
    const mode = checkoutMode();
    const ready = readyForCheckout(mode, config);
    return json({ mode, ready, paused: config.paused, slots: ready ? await upcomingSlots(config, Date.now(), mode) : [] }, 200, mode);
  }
  if (get && resource === "pedido" && action && !item) {
    const order = await getOrder(action);
    return json(order, 200, order.mode);
  }
  if (!get && resource === "pedido" && !action) {
    const order = await createOrder(await bodyOf(request));
    return json(order, 200, order.mode);
  }
  if (!get && resource === "mercado-pago" && action === "preferencia" && item) {
    return json(await getCheckoutLink(item));
  }
  if (!get && resource === "mercado-pago" && action === "conciliar" && (item === "teste" || item === "producao")) {
    if (new URL(request.url).protocol !== "https:") throw new Problem(403, "Conciliação restrita.");
    await assertReconciliationKey(request.headers);
    await expireOrders(Date.now());
    return json(await runReconciliation(database(), item), 200, item);
  }
  if (!get && (resource === "pagamento-demo" || resource === "pagamento") && action && !item) {
    const body = await bodyOf(request);
    if (resource === "pagamento-demo" && body.mode !== "demo") {
      throw new Problem(400, "Este recurso simula pagamentos de teste.");
    }
    // The previous route remains available to pages opened before the update.
    return json(await resolvePayment(action, body.action), 200, "demo");
  }
  if (get && resource === "avdi" && !action) return json(await getPublishedSubmissions());
  if (get && resource === "fotos" && action && !item) return readPhoto(action);
  if (get && resource === "admin" && !action) {
    const state = await adminState();
    return json(state, 200, state.mode);
  }
  if (!get && resource === "admin") {
    if (action === "upload" && !item) return json(await uploadPhoto(request));
    const body = await bodyOf(request);
    if (action === "operacao" && !item) return json(await updateOperation(body));
    if (action === "comercial" && !item) return json(await updateCommercialInfo(body));
    if (action === "conciliar") {
      if (item && !/^[a-f0-9-]{36}$/.test(item)) throw new Problem(400, "Pedido inválido para conciliação.");
      await expireOrders(Date.now());
      return json(await runReconciliation(database(), checkoutMode(), item));
    }
    if (action === "pausa" && !item) return json(await pauseOperation(body.paused));
    if (action === "produto" && item) return json(await updateProduct(item, body));
    if (action === "pedido" && item) return json(await moveOrder(item, body.action, body.code, signedInId(request.headers)));
    if (action === "avdi" && item) return json(await updateSubmission(item, body));
  }
  throw new Problem(404, "Recurso não encontrado.");
}

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    return await route(request, (await context.params).path);
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message }, error.status);
    console.error("Food Truck Federal API · falha de serviço", request.method);
    return json({ error: "O serviço está indisponível agora. Tente novamente em instantes." }, 503);
  }
}

export const GET = handle;
export const POST = handle;
