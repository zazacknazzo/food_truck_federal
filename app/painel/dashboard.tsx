"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowUpRight, BarChart3, Bell, CalendarClock, Camera, Check, ChevronDown, CirclePause, CirclePlay, ClipboardList,
  Clock3, GraduationCap, PackageOpen, Plus, Search, Settings2, TicketCheck, Trash2,
} from "lucide-react";
import {
  type CommercialInfo, type Config, type Metrics, type Mode, type Order, type Product, type SlotOverride, type Submission,
  categories, commercialFields, dayLabel, modes, money, normalize, orderLabel, payments, stages, time, weekdays, windowLabel,
} from "@/lib/federal";
import { ApiError, api, errorMessage } from "@/lib/client";
import { Brand, Empty, Modal } from "../site-ui";
import { OrderItems } from "../pedido/tracking";

type Finance = { refunds: number; reviews: number; interruptions: number; mismatches: number;
  problems: { orderId: string; paymentId: string; state: "requested" | "review" }[] };
type AdminData = { mode: Mode; config: Config; products: Product[]; orders: Order[]; history: Order[]; metrics: Metrics; finance: Finance | null; submissions: Submission[] };
const tabs = [
  { id: "fila", label: "Fila de pedidos", short: "Fila", icon: ClipboardList },
  { id: "catalogo", label: "Catálogo", short: "Catálogo", icon: PackageOpen },
  { id: "operacao", label: "Operação", short: "Operação", icon: Settings2 },
  { id: "metricas", label: "Métricas", short: "Métricas", icon: BarChart3 },
  { id: "avdi", label: "Projeto AVDI", short: "AVDI", icon: GraduationCap },
] as const;
type Tab = typeof tabs[number]["id"];
const panelRequestTimeoutMs = 10_000;

export default function Dashboard() {
  const [data, setData] = useState<AdminData | null>(null);
  const [tab, setTab] = useState<Tab>("fila");
  const [filter, setFilter] = useState<Filter>("todos");
  const [newOrders, setNewOrders] = useState<string[]>([]);
  const [connectionError, setConnectionError] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pausing, setPausing] = useState(false);
  const read = useRef<AbortController | null>(null);
  const seenNewOrders = useRef<Set<string> | null>(null);
  const refresh = useCallback(async (replace = false) => {
    if (read.current && !replace) return false;
    read.current?.abort();
    const request = new AbortController();
    read.current = request;
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(panelRequestTimeoutMs)]);
      const next = await api<AdminData>("admin", undefined, signal);
      if (request.signal.aborted) return false;
      const current = new Set(next.orders.filter(order => order.payment === "aprovado" && order.stage === "recebido").map(order => order.id));
      const previous = seenNewOrders.current;
      const arrived = previous ? [...current].filter(id => !previous.has(id)) : [];
      seenNewOrders.current = current;
      setNewOrders(ids => [...ids.filter(id => current.has(id)), ...arrived]);
      setData(next);
      setConnectionError("");
      setSessionExpired(false);
      return true;
    } catch (problem) {
      if (request.signal.aborted) return false;
      if (problem instanceof ApiError && problem.status === 403) {
        setData(null);
        setNewOrders([]);
        seenNewOrders.current = null;
        setSessionExpired(true);
        setConnectionError("A sessão do painel terminou. Entre com uma conta autorizada.");
      } else {
        setConnectionError("O painel perdeu a conexão. Tente atualizar para sincronizar a fila.");
      }
      return false;
    } finally {
      if (read.current === request) read.current = null;
    }
  }, []);

  useEffect(() => {
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    const offline = () => {
      read.current?.abort();
      read.current = null;
      setConnectionError("Sem conexão. O painel atualiza a fila quando a rede voltar.");
    };
    refreshVisible();
    const interval = setInterval(refreshVisible, 6500);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("online", refreshVisible);
    window.addEventListener("offline", offline);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener("offline", offline);
      read.current?.abort();
      read.current = null;
    };
  }, [refresh]);

  async function save(path: string, body: Record<string, unknown>, message: string) {
    if (connectionError) throw new Error("Atualize o painel antes de repetir a ação.");
    try {
      await api(path, body, AbortSignal.timeout(path.startsWith("admin/conciliar") ? 30_000 : panelRequestTimeoutMs));
    } catch (problem) {
      if (problem instanceof ApiError && [400, 403, 404, 409, 413, 415].includes(problem.status)) {
        if (problem.status === 403 || problem.status === 409) await refresh(true);
        throw problem;
      }
      const synced = await refresh(true);
      throw new Error(synced
        ? "A confirmação falhou. Confira o estado atualizado antes de repetir a ação."
        : "A confirmação falhou. Atualize o painel antes de repetir a ação.");
    }
    const synced = await refresh(true);
    setFeedback(synced ? message : `${message} Atualize o painel para sincronizar a fila.`);
  }
  async function pause() {
    if (!data) return;
    setError("");
    setPausing(true);
    try { await save("admin/pausa", { paused: !data.config.paused }, data.config.paused ? "Pedidos retomados." : "Novos pedidos pausados."); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setPausing(false); }
  }
  useEffect(() => { if (feedback) { const id = setTimeout(() => setFeedback(""), 3500); return () => clearTimeout(id); } }, [feedback]);

  function showTab(next: Tab) {
    if (next !== tab) setFilter("todos");
    setTab(next);
    setFeedback("");
    setError("");
    window.scrollTo({ top: 0 });
  }
  const newOrderLabel = newOrders.length === 1 ? "1 novo pedido aprovado" : `${newOrders.length} novos pedidos aprovados`;

  return <div className="dashboard">
    <aside className="admin-sidebar">
      <Brand />
      <div className="admin-sidebar-caption">Painel da proprietária</div>
      <nav aria-label="Navegação do painel">
        {tabs.map(({ id, label, short, icon: Icon }) => <button key={id} type="button" aria-label={label} aria-current={id === tab ? "page" : undefined} className={id === tab ? "selected" : ""}
          onClick={() => showTab(id)}><Icon size={19} /><span className="admin-nav-label">{label}</span><span className="admin-nav-short">{short}</span></button>)}
      </nav>
      <div className="admin-side-actions">
        {data?.config.paused && <span className="admin-paused"><CirclePause size={14} /> Pausado</span>}
        <a className="admin-store" href="/">Abrir loja <ArrowUpRight size={16} /></a>
      </div>
    </aside>
    <main className="admin-main">
      <div className="admin-top"><div><span className="eyebrow">{data && data.mode !== "demo" ? modes[data.mode] : "Operação demonstrativa"}</span><h1>{tabs.find(t => t.id === tab)?.label}</h1></div>
        {data && <button className={`button ${data.config.paused ? "button-primary" : "button-outline"}`} type="button" disabled={pausing || Boolean(connectionError)} onClick={pause}>
          {data.config.paused ? <CirclePlay size={19} /> : <CirclePause size={19} />} {data.config.paused ? "Retomar pedidos" : "Pausar pedidos"}
        </button>}</div>
      {data?.config.paused && <p className="notice" role="status">Novos pedidos pausados. A fila existente segue disponível.</p>}
      {connectionError && <div className="notice notice-error admin-notice"><p role="alert">{connectionError} {data && "Exibindo a última atualização."}</p>
        <button className="button button-outline" type="button" onClick={() => sessionExpired ? window.location.reload() : void refresh(true)}>{sessionExpired ? "Reabrir painel" : "Atualizar painel"}</button></div>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {feedback && <p className="admin-feedback" role="status"><Check size={17} /> {feedback}</p>}
      <p className="sr-only" role="status">{newOrders.length > 0 ? newOrderLabel : ""}</p>
      {newOrders.length > 0 && <div className="notice admin-notice"><p aria-hidden="true"><Bell size={17} /> {newOrderLabel}</p>
        <button className="button button-outline" type="button" onClick={() => { showTab("fila"); setFilter("todos"); setNewOrders([]); }}>Ver na fila</button></div>}
      {!data ? !connectionError && <p className="muted" role="status">Carregando operação…</p> : <>
        {tab === "fila" && <Queue orders={data.orders} history={data.history} mode={data.mode} filter={filter} onFilter={setFilter} stale={Boolean(connectionError)} save={save} />}
        {tab === "catalogo" && <CatalogEditor products={data.products} save={save} />}
        {tab === "operacao" && <div className="form-stack"><Operation config={data.config} save={save} /><CommercialForm info={data.config.commercial} save={save} /></div>}
        {tab === "metricas" && <><MetricsPanel metrics={data.metrics} mode={data.mode} />{data.finance && <FinancePanel finance={data.finance} stale={Boolean(connectionError)} save={save} />}</>}
        {tab === "avdi" && <Submissions products={data.products} submissions={data.submissions} save={save} />}
      </>}
    </main>
  </div>;
}

type Save = (path: string, body: Record<string, unknown>, message: string) => Promise<void>;
type Filter = "todos" | "recebido" | "em_preparo" | "pronto" | "pendente" | "historico";
function waiting(order: Order) { return order.stage === "aguardando_pagamento" || order.demo && order.payment === "pendente"; }
function Queue({ orders, history, mode, filter, onFilter, stale, save }: {
  orders: Order[]; history: Order[]; mode: Mode; filter: Filter; onFilter: (filter: Filter) => void; stale: boolean; save: Save;
}) {
  const counts = {
    recebido: orders.filter(order => order.payment === "aprovado" && order.stage === "recebido").length,
    em_preparo: orders.filter(order => order.stage === "em_preparo").length,
    pronto: orders.filter(order => order.stage === "pronto").length,
    pendente: orders.filter(waiting).length,
  };
  const filterList: { id: Filter; name: string; count: number }[] = [
    { id: "todos", name: "Fila", count: orders.length }, { id: "recebido", name: "Novos", count: counts.recebido },
    { id: "em_preparo", name: "Em preparo", count: counts.em_preparo }, { id: "pronto", name: "Prontos", count: counts.pronto },
    { id: "pendente", name: "Pendentes", count: counts.pendente }, { id: "historico", name: "Histórico", count: history.length },
  ];
  const visible = filter === "historico" ? history : orders.filter(order =>
    filter === "todos" || (filter === "pendente" ? waiting(order) : order.stage === filter && order.payment === "aprovado"));
  return <>
    <div className="queue-stats"><Stat title="Novos" value={counts.recebido} /><Stat title="Em preparo" value={counts.em_preparo} /><Stat title="Prontos" value={counts.pronto} /></div>
    <div className="admin-filters" aria-label="Filtrar fila">
      {filterList.map(f => <button className={`category-pill ${filter === f.id ? "active" : ""}`} key={f.id} aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}>{f.name} <small>{f.count}</small></button>)}
    </div>
    {visible.length ? <div className="queue-grid">{visible.map(order => <QueueCard key={order.id} order={order} stale={stale} save={save} />)}</div> :
      <Empty title={filter === "historico" ? "Histórico vazio" : "Nenhum pedido nesta fila"}>{filter === "historico" ? "Pedidos concluídos e cancelados dos últimos sete dias aparecem aqui." : mode === "producao" ? "Os pedidos disponíveis aparecem aqui." : <>Registre um pedido de teste na <a href="/#cardapio">loja</a> para ver a fila em ação.</>}</Empty>}
  </>;
}

function QueueCard({ order, stale, save }: { order: Order; stale: boolean; save: Save }) {
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const canMove = order.payment === "aprovado" && ["recebido", "em_preparo", "pronto"].includes(order.stage);
  const pending = waiting(order);
  const canCancel = canMove || pending;
  async function action(action: string, label: string) {
    if (sending.current || stale) return;
    sending.current = true;
    setBusy(true); setError("");
    try { await save(`admin/pedido/${order.id}`, { action, code }, label); setConfirm(false); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { sending.current = false; setBusy(false); }
  }
  return <article className="panel queue-card">
    <div className="queue-card-top"><div><small>{orderLabel(order.id)}</small><h2>{order.customer}</h2></div><span className={`state-badge stage-${pending ? "pendente" : order.stage}`}>{pending && order.demo ? "Reserva pendente" : stages[order.stage]}</span></div>
    <p className="queue-time"><CalendarClock size={17} /> {dayLabel(order.slot)} · {windowLabel(order.slot)} <span>{order.pickup === "agendada" ? "Agendado" : "Próxima vaga"}</span></p>
    <div className="queue-financial"><span>{order.method}{order.mode === "producao" ? "" : " de teste"}</span><strong>{payments[order.payment]}</strong></div>
    <OrderItems order={order} />
    <div className="summary order-total"><span>{order.mode === "producao" ? "Total" : "Total demonstrativo"}</span><strong>{money(order.total)}</strong></div>
    {pending && order.expires_at !== null && <p className="muted">Reserva até {time(order.expires_at)}.</p>}
    {order.events && <details className="order-events"><summary>Eventos do pedido <ChevronDown size={16} /></summary>
      <ul>{order.events.map((event, i) => <li key={i}><time>{time(event.at)}</time> {event.label}</li>)}</ul>
    </details>}
    {canMove && <div className="queue-actions">
      {order.stage === "recebido" && <button className="button button-primary full" disabled={busy || stale} onClick={() => action("start", "Preparo iniciado.")}><CirclePlay size={19} /> Iniciar preparo</button>}
      {order.stage === "em_preparo" && <button className="button button-primary full" disabled={busy || stale} onClick={() => action("ready", "Pedido pronto para retirada.")}><Check size={19} /> Marcar pronto</button>}
      {order.stage === "pronto" && <form className="pickup-form" onSubmit={event => { event.preventDefault(); void action("pickup", "Retirada confirmada."); }}>
        <label className="field"><span>Código mostrado pelo cliente</span><input value={code} onChange={event => setCode(event.target.value.toUpperCase())} minLength={5} maxLength={5} required placeholder="Código de 5 caracteres" autoComplete="off" autoCapitalize="characters" spellCheck={false} /></label>
        <button className="button button-primary full" disabled={busy || stale || code.trim().length !== 5}><TicketCheck size={19} /> Confirmar retirada</button></form>}
    </div>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {canCancel && (confirm ? <div className="notice cancel-confirm"><span>{order.demo ? "Cancelar este pedido de teste?" : canMove ? "Cancelar o pedido e solicitar o estorno integral?" : "Cancelar esta reserva?"}</span><button className="inline-action" disabled={busy || stale} onClick={() => action("cancel", "Pedido cancelado.")}>Confirmar cancelamento</button><button className="inline-action" onClick={() => setConfirm(false)}>Voltar</button></div>
      : <button className="inline-action danger" onClick={() => setConfirm(true)}>Cancelar pedido</button>)}
  </article>;
}

function CatalogEditor({ products, save }: { products: Product[]; save: Save }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("todos");
  const [editing, setEditing] = useState<Product | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function toggle(product: Product) {
    setBusy(product.id); setError("");
    try { await save(`admin/produto/${product.id}`, { action: "availability", disponivel: product.disponivel === false }, "Disponibilidade atualizada."); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(""); }
  }
  const list = products.filter(p => normalize(p.nome).includes(normalize(query)) && (category === "todos" || p.categoria === category));
  return <>
    <div className="admin-catalog-controls"><label className="search"><Search size={19} /><input aria-label="Buscar produto" placeholder="Buscar produto" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label className="field"><span className="sr-only">Categoria</span><select value={category} onChange={event => setCategory(event.target.value)}><option value="todos">Todas as categorias</option>{categories.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label></div>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {list.length ? <div className="panel product-table">{list.map(product => <div key={product.id} className="product-row">
      <div><strong>{product.nome}</strong><small>{money(product.preco_centavos)} {product.disponivel === false ? "· Esgotado" : "· Em demonstração"}</small></div>
      <button className="button button-outline button-small" disabled={busy === product.id} onClick={() => toggle(product)}>{product.disponivel === false ? "Reativar" : "Esgotar"}</button>
      <button className="button button-outline button-small" onClick={() => setEditing(product)}>Editar</button>
    </div>)}</div> : <Empty title="Nenhum produto encontrado" />}
    {editing && <Modal title={`Editar ${editing.nome}`} onClose={() => setEditing(null)} kind="product-modal"><ProductEdit product={editing} save={save} close={() => setEditing(null)} /></Modal>}
  </>;
}

function ProductEdit({ product, save, close }: { product: Product; save: Save; close: () => void }) {
  const [name, setName] = useState(product.nome);
  const [description, setDescription] = useState(product.descricao_fonte);
  const [price, setPrice] = useState((product.preco_centavos / 100).toFixed(2));
  const [variants, setVariants] = useState(product.variantes.map(v => (v.preco_centavos / 100).toFixed(2)));
  const [photo, setPhoto] = useState<string | null>(product.foto);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await save(`admin/produto/${product.id}`, { nome: name, descricao_fonte: description,
        preco_centavos: Math.round(Number(price) * 100), variantPrices: variants.map(value => Math.round(Number(value) * 100)),
        foto: photo }, "Produto atualizado.");
      close();
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="modal-form"><div className="modal-body form-stack">
    <label className="field"><span>Nome</span><input value={name} onChange={event => setName(event.target.value)} required maxLength={85} /></label>
    <label className="field"><span>Ingredientes e descrição</span><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={650} rows={3} /></label>
    {product.variantes.length ? <div className="checkout-times">{product.variantes.map((v, i) => <label key={v.id} className="field"><span>{v.rotulo} · R$</span><input type="number" min={0} max={1000} step=".01" value={variants[i]} onChange={event => setVariants(variants.map((current, index) => index === i ? event.target.value : current))} required /></label>)}</div>
      : <label className="field"><span>Preço em reais</span><input type="number" min={0} max={1000} step=".01" required value={price} onChange={event => setPrice(event.target.value)} /></label>}
    <PhotoInput label="Foto real do produto" value={photo} onChange={setPhoto} onBusy={setUploading} />
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    </div><div className="modal-foot"><button className="button button-primary full" disabled={busy || uploading}>Salvar produto <Check size={19} /></button></div></form>;
}

function Operation({ config, save }: { config: Config; save: Save }) {
  const [draft, setDraft] = useState(config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function updateRange(index: number, values: Partial<SlotOverride>) {
    setDraft(prev => ({ ...prev, overrides: prev.overrides.map((range, i) => i === index ? { ...range, ...values } : range) }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await save("admin/operacao", { capacity: draft.capacity, leadMinutes: draft.leadMinutes, hours: draft.hours, overrides: draft.overrides }, "Horários e capacidade atualizados."); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <form className="form-stack" onSubmit={submit}>
    <div className="panel form-stack"><h2>Capacidade por janela</h2>
      <label className="field capacity-field"><span>Pedidos a cada 15 minutos</span><input type="number" value={draft.capacity || ""} required min={1} max={15} onChange={event => setDraft({ ...draft, capacity: Number(event.target.value) })} /></label>
      <label className="field capacity-field"><span>Antecedência mínima em minutos</span><input type="number" value={draft.leadMinutes || ""} required min={10} max={120} onChange={event => setDraft({ ...draft, leadMinutes: Number(event.target.value) })} /></label>
      <p className="muted">Os horários usam o fuso de São Paulo. Alterações valem para novas reservas.</p></div>
    <div className="panel form-stack"><h2>Horários da semana</h2>
      {draft.hours.map((item, index) => <div className="schedule-row" key={weekdays[index]}>
        <label className="schedule-day"><input type="checkbox" checked={item.open} onChange={event => setDraft({ ...draft, hours: draft.hours.map((h, i) => i === index ? { ...h, open: event.target.checked } : h) })} /> {weekdays[index]}</label>
        <label className="field"><span className="sr-only">{weekdays[index]} abertura</span><TimeSelect value={item.start} disabled={!item.open} onChange={start => setDraft({ ...draft, hours: draft.hours.map((h, i) => i === index ? { ...h, start } : h) })} /></label>
        <label className="field"><span className="sr-only">{weekdays[index]} encerramento</span><TimeSelect end value={item.end} disabled={!item.open} onChange={end => setDraft({ ...draft, hours: draft.hours.map((h, i) => i === index ? { ...h, end } : h) })} /></label>
      </div>)}
    </div>
    <div className="panel form-stack"><h2>Ajustes por data e faixa</h2><p className="muted">Use 0 para bloquear uma faixa. Cada ajuste vale para as janelas entre o início e o fim.</p>
      {draft.overrides.map((range, index) => <div className="override-row" key={index}>
        <label className="field"><span>Data</span><input type="date" required value={range.date} onChange={event => updateRange(index, { date: event.target.value })} /></label>
        <label className="field"><span>Início</span><TimeSelect value={range.start} onChange={start => updateRange(index, { start })} /></label>
        <label className="field"><span>Fim</span><TimeSelect end value={range.end} onChange={end => updateRange(index, { end })} /></label>
        <label className="field"><span>Capacidade</span><input type="number" min={0} max={15} value={range.capacity} onChange={event => updateRange(index, { capacity: Number(event.target.value) })} required /></label>
        <button className="icon-button danger" type="button" aria-label="Remover ajuste" onClick={() => setDraft({ ...draft, overrides: draft.overrides.filter((_, i) => i !== index) })}><Trash2 size={18} /></button>
      </div>)}
      <button type="button" className="button button-outline" disabled={draft.overrides.length >= 60} onClick={() => setDraft({ ...draft, overrides: [...draft.overrides, { date: "", start: "12:00", end: "12:15", capacity: 0 }] })}><Plus size={18} /> Adicionar ajuste</button>
    </div>
    {error && <p className="notice notice-error" role="alert">{error}</p>}<div><button className="button button-primary" disabled={busy}>Salvar operação <Check size={19} /></button></div>
  </form>;
}

function CommercialForm({ info, save }: { info: CommercialInfo; save: Save }) {
  const [draft, setDraft] = useState(info);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await save("admin/comercial", draft, "Dados comerciais atualizados."); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <form className="panel form-stack" onSubmit={submit}>
    <h2>Dados comerciais e políticas</h2>
    <p className="muted">Preencha apenas informações próprias para divulgação. Confira os dados antes de publicá-los no rodapé da loja.</p>
    {commercialFields.map(({ key, label, limit }) => <label className="field" key={key}><span>{label}</span>
      {limit > 1000 ? <textarea rows={3} value={draft[key]} maxLength={limit} onChange={event => setDraft({ ...draft, [key]: event.target.value, reviewed: false })} />
        : <input value={draft[key]} maxLength={limit} onChange={event => setDraft({ ...draft, [key]: event.target.value, reviewed: false })} />}
    </label>)}
    <label className="schedule-day"><input type="checkbox" checked={draft.reviewed} onChange={event => setDraft({ ...draft, reviewed: event.target.checked })} /> Dados conferidos e autorizados para publicação</label>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    <div><button className="button button-primary" disabled={busy}>Salvar dados comerciais <Check size={19} /></button></div>
  </form>;
}

const timeOptions = Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String(i % 4 * 15).padStart(2, "0")}`);
function TimeSelect({ value, onChange, disabled, end }: { value: string; onChange: (value: string) => void; disabled?: boolean; end?: boolean }) {
  return <select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{(end ? timeOptions.slice(1) : timeOptions.slice(0, -1)).map(option => <option key={option}>{option}</option>)}</select>;
}

function Stat({ title, value }: { title: string; value: ReactNode }) {
  return <div className="panel stat"><span>{title}</span><strong>{value}</strong></div>;
}

function MetricsPanel({ metrics, mode }: { metrics: Metrics; mode: Mode }) {
  const paymentScope = mode === "producao" ? "" : " de teste";
  return <>
    <p className="muted metrics-caption">Últimos sete dias · {modes[mode]}</p>
    <div className="metrics-stats"><Stat title="Pedidos registrados" value={metrics.count} /><Stat title="Pagamentos aprovados" value={metrics.approved} /><Stat title="Valor aprovado" value={money(metrics.value)} /><Stat title="Ticket médio" value={money(metrics.average)} /></div>
    <div className="metrics-grid">
      <div className="panel"><h2>Itens mais pedidos</h2>{metrics.top.length ? <div className="bar-list">{metrics.top.map(item => <div key={item.name}><div><strong>{item.name}</strong><span>{item.quantity}</span></div><progress aria-label={item.name} value={item.quantity} max={metrics.top[0].quantity} /></div>)}</div> : <p className="muted">Os pedidos aprovados{paymentScope} vão aparecer aqui.</p>}</div>
      <div className="panel"><h2>Ocupação por janela</h2>{metrics.occupancy.length ? <div className="bar-list">{metrics.occupancy.map(window => <div key={window.start}><div><strong>{dayLabel(window.start)} · {windowLabel(window.start)}</strong><span>{window.count}/{window.capacity}</span></div><progress aria-label={windowLabel(window.start)} value={window.count} max={Math.max(window.capacity, window.count)} /></div>)}</div> : <p className="muted">Nenhuma janela futura com reservas{paymentScope}.</p>}</div>
      <div className="panel"><h2><Clock3 size={21} /> Tempo médio de preparo</h2><p className="metric-value">{metrics.prepMinutes === null ? "Sem medições" : `${metrics.prepMinutes.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} min`}</p><p className="muted">Do início do preparo ao momento em que o pedido fica pronto.</p></div>
    </div>
  </>;
}

function FinancePanel({ finance, stale, save }: { finance: Finance; stale: boolean; save: Save }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function reconcile(orderId?: string) {
    setBusy(orderId ?? "batch"); setError("");
    const path = orderId ? `admin/conciliar/${orderId}` : "admin/conciliar";
    try { await save(path, {}, orderId ? "Pedido consultado no Mercado Pago." : "Lote de conciliação consultado."); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(""); }
  }
  return <section className="panel form-stack finance-panel" aria-label="Conciliação Mercado Pago">
    <h2>Conciliação Mercado Pago</h2>
    <p>Estornos aguardando confirmação {finance.refunds} · Em revisão {finance.reviews}</p>
    <p className="muted">Últimas 24 horas · Interrupções {finance.interruptions} · Divergências {finance.mismatches}</p>
    <div><button className="button button-outline" type="button" disabled={Boolean(busy) || stale} onClick={() => reconcile()}>{busy === "batch" ? "Consultando…" : "Conciliar pagamentos"}</button></div>
    {finance.problems.length > 0 && <div className="form-stack">
      {finance.problems.map(problem => <div className="admin-notice notice" key={problem.paymentId}>
        <div><strong>{orderLabel(problem.orderId)} · {problem.state === "review" ? "Em revisão" : "Estorno solicitado"}</strong>
          <p>Pagamento {problem.paymentId}</p></div>
        <button className="button button-outline" type="button" disabled={Boolean(busy) || stale} onClick={() => reconcile(problem.orderId)}>
          {busy === problem.orderId ? "Consultando…" : "Consultar pedido"}
        </button>
      </div>)}
    </div>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>;
}

function Submissions({ products, submissions, save }: { products: Product[]; submissions: Submission[]; save: Save }) {
  return <><p className="muted metrics-caption">Associe cada integrante a um produto. Publique duas fotos do mesmo item.</p><div className="queue-grid">
    {submissions.map(submission => <SubmissionForm key={submission.student} item={submission} products={products} save={save} />)}
  </div></>;
}

function SubmissionForm({ item, products, save }: { item: Submission; products: Product[]; save: Save }) {
  const [product, setProduct] = useState(item.product);
  const [original, setOriginal] = useState(item.original);
  const [edited, setEdited] = useState(item.edited);
  const [uploadOriginal, setUploadOriginal] = useState(false);
  const [uploadEdited, setUploadEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await save(`admin/avdi/${item.student}`, { product, original, edited }, `Trabalho de ${item.student} atualizado.`); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <form className="panel form-stack" onSubmit={submit}><h2>{item.student}</h2>
    <label className="field"><span>Produto</span><select value={product} disabled={uploadOriginal || uploadEdited} onChange={event => { setProduct(event.target.value); setOriginal(null); setEdited(null); }}>{products.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}</select></label>
    <PhotoInput label="Foto original" value={original} onChange={setOriginal} onBusy={setUploadOriginal} />
    <PhotoInput label="Foto editada por IA" value={edited} onChange={setEdited} onBusy={setUploadEdited} />
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    <button className="button button-primary" disabled={busy || uploadOriginal || uploadEdited}>Salvar publicação <Check size={19} /></button>
  </form>;
}

function PhotoInput({ label, value, onChange, onBusy }: { label: string; value: string | null; onChange: (url: string | null) => void; onBusy: (value: boolean) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function upload(file: File | undefined) {
    if (!file) return;
    setError("");
    if (file.size > 4 * 1024 * 1024) { setError("A imagem precisa ter até 4 MB."); return; }
    setBusy(true); onBusy(true);
    try {
      const bitmap = await createImageBitmap(file).catch(() => { throw new Error("Não foi possível abrir a foto. Confira o arquivo JPG, PNG ou WebP."); });
      const canvas = document.createElement("canvas");
      try {
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Não foi possível preparar a foto neste navegador.");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      } finally { bitmap.close(); }
      // Upload the rendered pixels so the public copy has no camera or GPS metadata.
      const image = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Não foi possível preparar a foto.")), "image/webp", .9);
      });
      onChange((await api<{ url: string }>("admin/upload", new File([image], "foto", { type: image.type }))).url);
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); onBusy(false); }
  }
  return <div className="photo-input">
    {value && <img src={value} alt={label} />}
    <label className="field"><span><Camera size={17} /> {label}</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
    {busy && <small role="status">Enviando foto…</small>}{error && <small className="danger" role="alert">{error}</small>}
    {value && <button type="button" className="inline-action danger" onClick={() => onChange(null)}>Remover foto</button>}
  </div>;
}
