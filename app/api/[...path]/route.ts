import {
  adminState, createOrder, getOrder, getPublishedSubmissions, isOperator, moveOrder, pauseOperation, Problem, readBoundedBody,
  readPhoto, resolvePayment, storeContext, upcomingSlots, updateOperation, updateProduct, updateSubmission, uploadPhoto,
} from "@/lib/federal-server";

export const dynamic = "force-dynamic";

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Federal-Mode": "demo", "X-Content-Type-Options": "nosniff" } });
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
  const origin = request.headers.get("origin");
  if (!get && (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== new URL(request.url).origin))) {
    throw new Problem(403, "Abra o formulário no site da Kombi.");
  }
  if (path.length > 3) throw new Problem(404, "Recurso não encontrado.");
  if (resource === "admin" && !isOperator(request.headers)) throw new Problem(403, "Entre com uma conta autorizada para operar o painel.");

  if (get && resource === "loja" && !action) {
    const { products, config } = await storeContext();
    return json({ products, paused: config.paused });
  }
  if (get && resource === "horarios" && !action) {
    const { config } = await storeContext();
    return json({ paused: config.paused, slots: await upcomingSlots(config) });
  }
  if (get && resource === "pedido" && action && !item) return json(await getOrder(action));
  if (!get && resource === "pedido" && !action) return json(await createOrder(await bodyOf(request)));
  if (!get && (resource === "pagamento-demo" || resource === "pagamento") && action && !item) {
    const body = await bodyOf(request);
    if (resource === "pagamento-demo" && body.mode !== "demo") {
      throw new Problem(400, "Este recurso simula pagamentos de teste.");
    }
    // The previous route remains available to pages opened before the update.
    return json(await resolvePayment(action, body.action));
  }
  if (get && resource === "avdi" && !action) return json(await getPublishedSubmissions());
  if (get && resource === "fotos" && action && !item) return readPhoto(action);
  if (get && resource === "admin" && !action) return json(await adminState());
  if (!get && resource === "admin") {
    if (action === "upload" && !item) return json(await uploadPhoto(request));
    const body = await bodyOf(request);
    if (action === "operacao" && !item) return json(await updateOperation(body));
    if (action === "pausa" && !item) return json(await pauseOperation(body.paused));
    if (action === "produto" && item) return json(await updateProduct(item, body));
    if (action === "pedido" && item) return json(await moveOrder(item, body.action, body.code));
    if (action === "avdi" && item) return json(await updateSubmission(item, body));
  }
  throw new Problem(404, "Recurso não encontrado.");
}

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    return await route(request, (await context.params).path);
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message }, error.status);
    console.error("Food Truck Federal API", request.method, error instanceof Error ? error.name : "Falha inesperada");
    return json({ error: "O serviço está indisponível agora. Tente novamente em instantes." }, 503);
  }
}

export const GET = handle;
export const POST = handle;
