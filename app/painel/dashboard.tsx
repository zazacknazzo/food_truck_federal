"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowUpRight, BarChart3, CalendarClock, Camera, Check, ChevronDown, CirclePause, CirclePlay, ClipboardList,
  Clock3, GraduationCap, PackageOpen, Plus, Search, Settings2, TicketCheck, Trash2,
} from "lucide-react";
import {
  type Config, type Metrics, type Order, type Product, type SlotOverride, type Submission,
  categories, dayLabel, money, normalize, orderLabel, payments, stages, time, weekdays, windowLabel,
} from "@/lib/federal";
import { api, errorMessage } from "@/lib/client";
import { Brand, Empty, Modal } from "../site-ui";
import { OrderItems } from "../pedido/tracking";

type AdminData = { config: Config; products: Product[]; orders: Order[]; history: Order[]; metrics: Metrics; submissions: Submission[] };
const tabs = [
  { id: "fila", label: "Fila de pedidos", icon: ClipboardList },
  { id: "catalogo", label: "Catálogo", icon: PackageOpen },
  { id: "operacao", label: "Operação", icon: Settings2 },
  { id: "metricas", label: "Métricas", icon: BarChart3 },
  { id: "avdi", label: "Projeto AVDI", icon: GraduationCap },
] as const;
type Tab = typeof tabs[number]["id"];

export default function Dashboard() {
  const [data, setData] = useState<AdminData | null>(null);
  const [tab, setTab] = useState<Tab>("fila");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pausing, setPausing] = useState(false);
  async function refresh() {
    try { setData(await api<AdminData>("admin")); setError(""); }
    catch (problem) { setError(errorMessage(problem)); }
  }
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 6500);
    return () => clearInterval(interval);
  }, []);

  async function save(path: string, body: Record<string, unknown>, message: string) {
    await api(path, body);
    await refresh();
    setFeedback(message);
  }
  async function pause() {
    if (!data) return;
    setPausing(true);
    try { await save("admin/pausa", { paused: !data.config.paused }, data.config.paused ? "Pedidos retomados." : "Novos pedidos pausados."); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setPausing(false); }
  }
  useEffect(() => { if (feedback) { const id = setTimeout(() => setFeedback(""), 3500); return () => clearTimeout(id); } }, [feedback]);

  return <div className="dashboard">
    <aside className="admin-sidebar">
      <Brand />
      <div className="admin-sidebar-caption">Painel da proprietária</div>
      <nav aria-label="Navegação do painel">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={id === tab ? "page" : undefined} className={id === tab ? "selected" : ""}
          onClick={() => { setTab(id); setFeedback(""); }}><Icon size={19} /> {label}</button>)}
      </nav>
      <a className="admin-store" href="/">Abrir loja <ArrowUpRight size={16} /></a>
    </aside>
    <main className="admin-main">
      <div className="admin-top"><div><span className="eyebrow">Operação demonstrativa</span><h1>{tabs.find(t => t.id === tab)?.label}</h1></div>
        {data && <button className={`button ${data.config.paused ? "button-primary" : "button-outline"}`} type="button" disabled={pausing} onClick={pause}>
          {data.config.paused ? <CirclePlay size={19} /> : <CirclePause size={19} />} {data.config.paused ? "Retomar pedidos" : "Pausar pedidos"}
        </button>}</div>
      {data?.config.paused && <p className="notice">Novos pedidos pausados. A fila existente segue disponível.</p>}
      {error && <p className="notice notice-error" role="alert">{error} <button className="inline-action" onClick={refresh}>Atualizar</button></p>}
      {feedback && <p className="admin-feedback" role="status"><Check size={17} /> {feedback}</p>}
      {!data ? !error && <p className="muted" role="status">Carregando operação…</p> : <>
        {tab === "fila" && <Queue orders={data.orders} history={data.history} save={save} />}
        {tab === "catalogo" && <CatalogEditor products={data.products} save={save} />}
        {tab === "operacao" && <Operation config={data.config} save={save} />}
        {tab === "metricas" && <MetricsPanel metrics={data.metrics} />}
        {tab === "avdi" && <Submissions products={data.products} submissions={data.submissions} save={save} />}
      </>}
    </main>
  </div>;
}

type Save = (path: string, body: Record<string, unknown>, message: string) => Promise<void>;
type Filter = "todos" | "recebido" | "em_preparo" | "pronto" | "pendente" | "historico";
function Queue({ orders, history, save }: { orders: Order[]; history: Order[]; save: Save }) {
  const [filter, setFilter] = useState<Filter>("todos");
  const counts = {
    recebido: orders.filter(order => order.payment === "aprovado" && order.stage === "recebido").length,
    em_preparo: orders.filter(order => order.stage === "em_preparo").length,
    pronto: orders.filter(order => order.stage === "pronto").length,
    pendente: orders.filter(order => order.payment === "pendente").length,
  };
  const filterList: { id: Filter; name: string; count: number }[] = [
    { id: "todos", name: "Fila", count: orders.length }, { id: "recebido", name: "Novos", count: counts.recebido },
    { id: "em_preparo", name: "Em preparo", count: counts.em_preparo }, { id: "pronto", name: "Prontos", count: counts.pronto },
    { id: "pendente", name: "Pendentes", count: counts.pendente }, { id: "historico", name: "Histórico", count: history.length },
  ];
  const visible = filter === "historico" ? history : orders.filter(order =>
    filter === "todos" || (filter === "pendente" ? order.payment === "pendente" : order.stage === filter && order.payment === "aprovado"));
  return <>
    <div className="queue-stats"><Stat title="Novos" value={counts.recebido} /><Stat title="Em preparo" value={counts.em_preparo} /><Stat title="Prontos" value={counts.pronto} /></div>
    <div className="admin-filters" aria-label="Filtrar fila">
      {filterList.map(f => <button className={`category-pill ${filter === f.id ? "active" : ""}`} key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.name} <small>{f.count}</small></button>)}
    </div>
    {visible.length ? <div className="queue-grid">{visible.map(order => <QueueCard key={order.id} order={order} save={save} />)}</div> :
      <Empty title={filter === "historico" ? "Histórico vazio" : "Nenhum pedido nesta fila"}>{filter === "historico" ? "Pedidos concluídos e cancelados dos últimos sete dias aparecem aqui." : <>Registre um pedido de teste na <a href="/#cardapio">loja</a> para ver a fila em ação.</>}</Empty>}
  </>;
}

function QueueCard({ order, save }: { order: Order; save: Save }) {
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canMove = order.payment === "aprovado" && ["recebido", "em_preparo", "pronto"].includes(order.stage);
  const canCancel = canMove || (order.stage === "recebido" && order.payment === "pendente");
  async function action(action: string, label: string) {
    setBusy(true); setError("");
    try { await save(`admin/pedido/${order.id}`, { action, code }, label); setConfirm(false); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <article className="panel queue-card">
    <div className="queue-card-top"><div><small>{orderLabel(order.id)}</small><h2>{order.customer}</h2></div><span className={`state-badge stage-${order.stage}`}>{stages[order.stage]}</span></div>
    <p className="queue-time"><CalendarClock size={17} /> {dayLabel(order.slot)} · {windowLabel(order.slot)} <span>{order.pickup === "agendada" ? "Agendado" : "Próxima vaga"}</span></p>
    <div className="queue-financial"><span>{order.method} de teste</span><strong>{payments[order.payment]}</strong></div>
    <OrderItems order={order} />
    <div className="summary order-total"><span>Total demonstrativo</span><strong>{money(order.total)}</strong></div>
    {order.payment === "pendente" && <p className="muted">Reserva pendente até {time(order.expires_at!)}.</p>}
    {order.events && <details className="order-events"><summary>Eventos do pedido <ChevronDown size={16} /></summary>
      <ul>{order.events.map((event, i) => <li key={i}><time>{time(event.at)}</time> {event.label}</li>)}</ul>
    </details>}
    {canMove && <div className="queue-actions">
      {order.stage === "recebido" && <button className="button button-primary full" disabled={busy} onClick={() => action("start", "Preparo iniciado.")}><CirclePlay size={19} /> Iniciar preparo</button>}
      {order.stage === "em_preparo" && <button className="button button-primary full" disabled={busy} onClick={() => action("ready", "Pedido pronto para retirada.")}><Check size={19} /> Marcar pronto</button>}
      {order.stage === "pronto" && <form className="pickup-form" onSubmit={event => { event.preventDefault(); void action("pickup", "Retirada confirmada."); }}>
        <label className="field"><span>Código mostrado pelo cliente</span><input value={code} onChange={event => setCode(event.target.value.toUpperCase())} minLength={5} maxLength={5} required placeholder="Código de 5 caracteres" autoComplete="off" /></label>
        <button className="button button-primary full" disabled={busy}><TicketCheck size={19} /> Confirmar retirada</button></form>}
    </div>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {canCancel && (confirm ? <div className="notice cancel-confirm"><span>Cancelar este pedido de teste?</span><button className="inline-action" disabled={busy} onClick={() => action("cancel", "Pedido cancelado.")}>Confirmar cancelamento</button><button className="inline-action" onClick={() => setConfirm(false)}>Voltar</button></div>
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
    try { await save("admin/operacao", { capacity: draft.capacity, hours: draft.hours, overrides: draft.overrides }, "Horários e capacidade atualizados."); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <form className="form-stack" onSubmit={submit}>
    <div className="panel form-stack"><h2>Capacidade por janela</h2><label className="field capacity-field"><span>Pedidos a cada 15 minutos</span><input type="number" value={draft.capacity || ""} required min={1} max={15} onChange={event => setDraft({ ...draft, capacity: Number(event.target.value) })} /></label><p className="muted">O limite inicial de 10 pedidos e os horários abaixo são parâmetros de teste. Os horários usam o fuso de São Paulo.</p></div>
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

const timeOptions = Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String(i % 4 * 15).padStart(2, "0")}`);
function TimeSelect({ value, onChange, disabled, end }: { value: string; onChange: (value: string) => void; disabled?: boolean; end?: boolean }) {
  return <select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{(end ? timeOptions.slice(1) : timeOptions.slice(0, -1)).map(option => <option key={option}>{option}</option>)}</select>;
}

function Stat({ title, value }: { title: string; value: ReactNode }) {
  return <div className="panel stat"><span>{title}</span><strong>{value}</strong></div>;
}

function MetricsPanel({ metrics }: { metrics: Metrics }) {
  return <>
    <p className="muted metrics-caption">Últimos sete dias · somente atividade demonstrativa</p>
    <div className="metrics-stats"><Stat title="Pedidos registrados" value={metrics.count} /><Stat title="Pagamentos aprovados" value={metrics.approved} /><Stat title="Valor aprovado" value={money(metrics.value)} /><Stat title="Ticket médio" value={money(metrics.average)} /></div>
    <div className="metrics-grid">
      <div className="panel"><h2>Itens mais pedidos</h2>{metrics.top.length ? <div className="bar-list">{metrics.top.map(item => <div key={item.name}><div><strong>{item.name}</strong><span>{item.quantity}</span></div><progress aria-label={item.name} value={item.quantity} max={metrics.top[0].quantity} /></div>)}</div> : <p className="muted">Os pedidos aprovados de teste vão aparecer aqui.</p>}</div>
      <div className="panel"><h2>Ocupação por janela</h2>{metrics.occupancy.length ? <div className="bar-list">{metrics.occupancy.map(window => <div key={window.start}><div><strong>{dayLabel(window.start)} · {windowLabel(window.start)}</strong><span>{window.count}/{window.capacity}</span></div><progress aria-label={windowLabel(window.start)} value={window.count} max={Math.max(window.capacity, window.count)} /></div>)}</div> : <p className="muted">Nenhuma janela futura com reservas de teste.</p>}</div>
      <div className="panel"><h2><Clock3 size={21} /> Tempo médio de preparo</h2><p className="metric-value">{metrics.prepMinutes === null ? "Sem medições" : `${metrics.prepMinutes.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} min`}</p><p className="muted">Do início do preparo ao momento em que o pedido fica pronto.</p></div>
    </div>
  </>;
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
    try { onChange((await api<{ url: string }>("admin/upload", file)).url); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); onBusy(false); }
  }
  return <div className="photo-input">
    {value && <img src={value} alt={label} />}
    <label className="field"><span><Camera size={17} /> {label}</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
    {busy && <small role="status">Enviando foto…</small>}{error && <small className="danger" role="alert">{error}</small>}
    {value && <button type="button" className="inline-action danger" onClick={() => onChange(null)}>Remover foto</button>}
  </div>;
}
