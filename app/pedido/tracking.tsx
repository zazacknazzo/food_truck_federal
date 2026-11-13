"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, Copy, CreditCard, Receipt, TicketCheck } from "lucide-react";
import { type Order, dayLabel, money, orderLabel, payments, stages, steps, time, windowLabel } from "@/lib/federal";
import { api, errorMessage, rememberedOrders, rememberOrder, type RememberedOrder } from "@/lib/client";
import { Empty, LocationLink, SiteFooter, SiteHeader } from "../site-ui";

export function OrderHistory() {
  const [list, setList] = useState<RememberedOrder[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const hydrate = setTimeout(() => setList(rememberedOrders()), 0);
    return () => clearTimeout(hydrate);
  }, []);
  function lookup(event: FormEvent) {
    event.preventDefault();
    const token = value.trim().match(/(?:^|\/pedido\/)([a-f0-9]{32})(?:\/?(?:[?#].*)?)$/i)?.[1];
    if (!token) { setError("Cole o link completo recebido ao registrar o pedido."); return; }
    window.location.assign(`/pedido/${token.toLowerCase()}`);
  }
  return <><SiteHeader /><main className="container page-shell narrow">
    <a className="back-link" href="/#cardapio"><ArrowLeft size={17} /> Voltar ao cardápio</a>
    <h1>Meus pedidos</h1>
    <p className="page-intro">Abra um pedido deste navegador ou use o link de acompanhamento recebido no checkout.</p>
    <div className="panel order-history">
      <h2>Neste navegador</h2>
      {list.length > 0 ? list.map(item => <a href={`/pedido/${item.tracking}`} className="history-row" key={item.tracking}><Receipt size={22} /><div><strong>{orderLabel(item.id)}</strong><small>{dayLabel(item.created_at)} · {time(item.created_at)}</small></div><ArrowRight size={19} /></a>) : <Empty title="Nenhum pedido registrado aqui">Se você já tem um link, cole no campo abaixo.</Empty>}
    </div>
    <form className="panel form-stack" onSubmit={lookup}><h2>Abrir por link</h2><label className="field"><span>Link privado do pedido</span><input value={value} onChange={event => setValue(event.target.value)} required placeholder="Cole o link de acompanhamento" /></label>
      {error && <p className="notice notice-error" role="alert">{error}</p>}<div><button className="button button-primary">Acompanhar pedido <ArrowRight size={19} /></button></div></form>
  </main><SiteFooter /></>;
}

export function Tracking({ token }: { token: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const read = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const terminal = order?.stage === "cancelado" || order?.stage === "retirado";
  const refresh = useCallback(async () => {
    if (sending.current || read.current) return;
    const controller = new AbortController();
    read.current = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      const result = await api<Order>(`pedido/${encodeURIComponent(token)}`, undefined, signal);
      if (!controller.signal.aborted) { setOrder(result); rememberOrder(result); setError(""); }
    } catch (problem) {
      if (!controller.signal.aborted) setError(errorMessage(problem));
    } finally {
      if (read.current === controller) read.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [token]);
  useEffect(() => {
    if (terminal) return;
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    const initial = setTimeout(() => { void refresh(); }, 0);
    const interval = setInterval(refreshVisible, 5000);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("online", refreshVisible);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("online", refreshVisible);
      read.current?.abort();
      read.current = null;
    };
  }, [refresh, terminal]);
  async function payment(action: string) {
    if (sending.current) return;
    sending.current = true;
    read.current?.abort();
    read.current = null;
    setBusy(true); setFeedback("");
    try { setOrder(await api<Order>(`pagamento-demo/${token}`, { mode: "demo", action })); }
    catch (problem) { setFeedback(errorMessage(problem)); }
    finally { sending.current = false; setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(window.location.href); setFeedback("Link privado copiado."); }
    catch { setFeedback("Você pode copiar o link pela barra de endereços."); }
  }
  const step = order ? steps.findIndex(state => state === order.stage) : -1;
  const inactive = order?.stage === "cancelado";
  const heading = order ? inactive ? "Pedido encerrado." : order.stage === "retirado" ? "Retirada confirmada." : order.payment === "pendente" ? "Reserva criada." : "Pedido na Kombi." : "Acompanhar pedido";
  return <><SiteHeader /><main className="container page-shell">
    <a className="back-link" href="/pedido"><ArrowLeft size={17} /> Meus pedidos</a>
    {loading ? <div className="panel" role="status">Consultando o pedido…</div> : !order ? <div className="panel">
      <h1>Pedido indisponível</h1><p className="page-intro">{error}</p><button className="button button-outline" onClick={refresh}>Consultar novamente</button>
    </div> : <>
      <div className="tracking-head"><div><span className="eyebrow">Pedido de demonstração · {orderLabel(order.id)}</span><h1>{heading}</h1></div><button className="button button-outline" onClick={copy}><Copy size={18} /> Copiar link privado</button></div>
      {error && <p className="notice" role="status">{error}</p>}
      {feedback && <p className="notice" role="status">{feedback}</p>}
      <div className="tracking-grid">
          <section className="panel tracking-progress" aria-label="Estado do pedido">
            <div className="progress-title"><h2>Acompanhamento</h2><span className={`state-badge stage-${order.stage}`}>{stages[order.stage]}</span></div>
            {inactive ? <p>A simulação foi encerrada. Para fazer outro teste, volte ao cardápio.</p> : order.payment === "pendente"
              ? <p>O horário está reservado até {time(order.expires_at!)}. O preparo começa após a aprovação de teste.</p>
              : <ol className="progress-steps">{steps.map((state, index) => <li key={state} className={index <= step ? "done" : ""} aria-current={index === step ? "step" : undefined}><span>{index <= step ? <Check size={17} /> : <i />}</span>{stages[state]}</li>)}</ol>}
            <div className="tracking-meta"><div><Clock3 size={21} /><span><small>Janela estimada</small><strong>{dayLabel(order.slot)} · {windowLabel(order.slot)}</strong></span></div>
              <div><CreditCard size={21} /><span><small>{order.method} demonstrativo</small><strong>{payments[order.payment]}</strong></span></div></div>
            {order.payment === "pendente" && <div className="pending-actions">
              <button className="button button-primary" disabled={busy} onClick={() => payment("aprovado")}>Simular aprovação</button>
              <button className="button button-outline" disabled={busy} onClick={() => payment("recusado")}>Simular recusa</button>
              <button className="inline-action" disabled={busy} onClick={() => payment("expirado")}>Expirar reserva</button>
            </div>}
          </section>
        <aside className="panel pickup-ticket">
          <div className="ticket-icon"><TicketCheck size={26} /></div><h2>Retirada na Kombi</h2><p>Nome no pedido <strong>{order.customer}</strong></p>
          {order.code && order.stage !== "retirado" ? <><p>Apresente este código no balcão quando o pedido estiver pronto.</p><strong className="pickup-code">{order.code}</strong></>
            : order.stage === "retirado" ? <div className="notice"><Check size={17} /> Código validado pela operação.</div>
            : <p>{inactive ? "A retirada foi cancelada." : "O código aparece após a aprovação de teste."}</p>}
          <LocationLink />
          {inactive && <a className="button button-primary full" href="/#cardapio">Voltar ao cardápio <ArrowRight size={18} /></a>}
        </aside>
        <section className="panel tracking-summary"><h2>Resumo do pedido</h2><OrderItems order={order} /><div className="summary order-total"><span>Total de teste</span><strong>{money(order.total)}</strong></div></section>
      </div>
    </>}
  </main><SiteFooter /></>;
}

export function OrderItems({ order }: { order: Order }) {
  return <div className="order-items">{order.items.map((item, index) =>
    <div className="order-item" key={`${item.product}-${index}`}><div>
      <strong>{item.quantity} × {item.name}</strong>
      {[item.variant, item.press, ...item.extras.map(e => e.name)].some(Boolean) && <small>{[item.variant, item.press, ...item.extras.map(e => e.name)].filter(Boolean).join(" · ")}</small>}
      {item.note && <small>Obs. {item.note}</small>}
    </div><strong>{money(item.total)}</strong></div>
  )}</div>;
}
