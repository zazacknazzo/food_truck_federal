"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown, ArrowDownRight, ArrowLeft, ArrowRight, CalendarClock, Check, ChevronDown, Clock3, CreditCard, MapPin,
  Minus, Plus, Search, ShoppingBag, TicketCheck, Trash2,
} from "lucide-react";
import {
  type CartLine, type CommercialInfo, type Method, type Mode, type Order, type Pickup, type Product, type Scenario, type Slot,
  categories, dateKey, dayLabel, extrasFor, featured, linePrice, money, normalize, originalProducts, payments, windowLabel,
} from "@/lib/federal";
import { ApiError, api, captureCampaign, errorMessage, readCart, rememberOrder, writeLocal } from "@/lib/client";
import { finishCheckoutAttempt, pendingCheckoutAttempt, startCheckoutAttempt, type CheckoutRequest } from "@/lib/checkout-attempt.mjs";
import { Campaign, CategoryIcon, Empty, LocationLink, Modal, SiteFooter, SiteHeader } from "./site-ui";

const cartKey = "federal-sacola-v1";
const checkoutResponseTimeoutMs = 20_000;
type Pane = "bag" | "checkout" | "product" | null;

export default function Home({ initialMode }: { initialMode: Mode }) {
  const [products, setProducts] = useState(originalProducts);
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [commercial, setCommercial] = useState<CommercialInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [pane, setPane] = useState<Pane>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [returnToBag, setReturnToBag] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("todos");
  const [all, setAll] = useState(false);
  const [toast, setToast] = useState("");
  const [campaign, setCampaign] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function syncStore() {
    try {
      const result = await api<{ products: Product[]; paused: boolean; mode: Mode; commercial: CommercialInfo | null }>("loja");
      setProducts(result.products);
      setPaused(result.paused);
      setMode(result.mode);
      setCommercial(result.commercial);
      setLoadError("");
    } catch (error) { setLoadError(errorMessage(error)); }
  }

  useEffect(() => {
    const hydrate = setTimeout(() => {
      setCart(readCart(cartKey));
      setCampaign(captureCampaign());
      void syncStore();
    }, 0);
    const timer = setInterval(() => { if (!document.hidden) void syncStore(); }, 15_000);
    return () => { clearTimeout(hydrate); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  const total = cart.reduce((sum, item) => sum + linePrice(item, products), 0);
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const unavailable = cart.some(line => products.find(p => p.id === line.product)?.disponivel === false || line.extras.some(id => products.find(p => p.id === id)?.disponivel === false));

  function changeCart(next: CartLine[]) { setCart(next); writeLocal(cartKey, next); }
  function selectProduct(product: Product, item: CartLine | null = null) {
    setSelected(product); setEditing(item); setReturnToBag(pane === "bag"); setPane("product");
  }
  function addLine(item: CartLine) {
    if (editing) changeCart(cart.map(line => line.key === item.key ? item : line));
    else {
      const match = cart.find(line => line.product === item.product && line.variant === item.variant &&
        line.press === item.press && line.extras.join() === item.extras.join() && line.note === item.note && line.quantity + item.quantity <= 15);
      changeCart(match ? cart.map(line => line.key === match.key ? { ...line, quantity: line.quantity + item.quantity } : line) : [...cart, item]);
    }
    setPane(returnToBag ? "bag" : null);
    setToast(editing ? "Item atualizado na sacola." : `${selected?.nome ?? "Item"} na sacola.`);
  }

  const search = normalize(query);
  const isFeatured = !search && category === "todos" && !all;
  const matches = products.filter(p => (category === "todos" || p.categoria === category)
    && (!search || search.split(/\s+/).every(term => normalize(`${p.nome} ${p.descricao_fonte}`).includes(term))));
  const result = isFeatured ? featured.map(id => products.find(p => p.id === id)!).filter(Boolean) : matches;
  const current = selected && products.find(p => p.id === selected.id);
  const suggestion = products.find(p => p.id === "refrigerante-lata" && p.disponivel !== false);
  function closePane() { if (!submitting) setPane(null); }

  return <>
    <a className="skip" href="#cardapio">Ir ao cardápio</a>
    <SiteHeader bag={count} onBag={() => setPane("bag")} mode={mode} home />
    <main>
      <section className="container hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <span className="eyebrow hero-place"><MapPin size={17} /> Canindé · São Paulo</span>
          <h1 id="hero-title">Seu lanche<br />favorito.<br /><em>Sem fila.</em></h1>
          <p>Dogões, hambúrgueres e porções da Kombi vermelha. Monte o seu lanche e escolha quando passar para buscar.</p>
          <div className="button-row hero-actions">
            <a className="button button-primary" href="#cardapio">Ver cardápio <ArrowDownRight size={21} /></a>
            <a className="button button-quiet" href="#como-funciona">Como funciona <ArrowDown size={17} /></a>
          </div>
        </div>
        <div className="hero-visual">
          <img className="hero-photo" src="/media/kombi.webp" alt="A Kombi vermelha do Food Truck Federal estacionada no Canindé" width="1024" height="576" fetchPriority="high" />
          <div className="photo-shadow" />
          <div className="hero-location"><MapPin size={24} /><span><strong>Retirada na Kombi</strong><small>Em frente ao IFSP · Campus São Paulo</small></span></div>
          <span className="hero-checker" aria-hidden="true" />
        </div>
      </section>

      <section id="cardapio" className="menu-section">
        <div className="container">
          <div className="menu-head">
            <div><span className="eyebrow">Cardápio</span><h2>Da Kombi pra você.</h2></div>
            <label className="search"><Search size={21} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar no cardápio" aria-label="Buscar no cardápio" /></label>
          </div>
          <div className="category-list" aria-label="Categorias do cardápio">
            {[{ id: "todos", nome: "Tudo" }, ...categories].map(c => <button key={c.id} type="button" aria-pressed={category === c.id}
              onClick={() => { setCategory(c.id); setAll(true); }} className={`category-pill ${category === c.id ? "active" : ""}`}>
              <CategoryIcon category={c.id} size={18} /> {c.nome}
            </button>)}
          </div>
          {paused && <p className="notice" role="status">Pedidos pausados. O cardápio continua disponível para consulta.</p>}
          {loadError && <p className="notice" role="status">{loadError} <button className="inline-action" onClick={syncStore}>Tentar novamente</button></p>}
          <div className="result-head"><h3>{isFeatured ? "Destaques" : category === "todos" ? "Todos os itens" : categories.find(c => c.id === category)?.nome}</h3><span aria-live="polite">{isFeatured ? "38 itens no cardápio" : `${result.length} ${result.length === 1 ? "item" : "itens"}`}</span></div>
          {result.length ? <div className="product-grid">{result.map(product =>
            <ProductCard key={product.id} product={product} onSelect={() => selectProduct(product)} />
          )}</div> : <Empty title="Nenhum item encontrado">Tente outro nome, ingrediente ou categoria.</Empty>}
          {isFeatured && <div className="full-menu"><button className="button button-outline" onClick={() => setAll(true)}>Ver todos os 38 itens <ChevronDown size={18} /></button></div>}
        </div>
      </section>

      <div className="container content-gap"><Campaign /></div>

      <section className="container pickup-section" id="como-funciona">
        <div className="section-title"><span className="eyebrow">Da escolha à retirada</span><h2>Como funciona</h2></div>
        <div className="pickup-grid">
          {[
            { Icon: ShoppingBag, title: "Monte seu pedido", text: "Escolha o lanche e ajuste o preparo, os complementos e a quantidade." },
            { Icon: CalendarClock, title: "Escolha a retirada", text: "Pegue a próxima vaga ou reserve uma janela de 15 minutos." },
            { Icon: TicketCheck, title: "Mostre seu código", text: "Acompanhe o preparo e use o código do pedido no balcão da Kombi." },
          ].map(({ Icon, title, text }) => <article key={title}><Icon size={28} strokeWidth={1.7} /><h3>{title}</h3><p>{text}</p></article>)}
        </div>
      </section>

      <section className="story-section" id="historia">
        <div className="container story-inner">
          <div className="story-photos">
            <img src="/media/dogao-lateral.webp" alt="O dogão e o balcão do Food Truck Federal" width="920" height="690" loading="lazy" />
            <img src="/media/dogao-detalhe.webp" alt="Detalhe do mesmo dogão registrado pela equipe" width="920" height="690" loading="lazy" />
          </div>
          <div className="story-copy"><span className="eyebrow">Nossa história</span><h2>A Kombi vermelha do Canindé.</h2><p>Em frente ao IFSP, a Kombi do Food Truck Federal faz parte da rotina de quem estuda, trabalha e passa pelo bairro. O cardápio reúne dogões, hambúrgueres e acompanhamentos para a pausa entre uma aula e outra.</p><LocationLink /></div>
        </div>
      </section>
    </main>
    <SiteFooter mode={mode} commercial={commercial} />
    {count > 0 && <div className="mobile-cart"><button className="button button-primary" onClick={() => setPane("bag")}><ShoppingBag size={19} /> Ver sacola <span>{count} {count === 1 ? "item" : "itens"} · {money(total)}</span></button></div>}
    <div className={`toast ${toast ? "toast-visible" : ""}`} role="status">{toast && <><Check size={18} /> {toast}</>}</div>
    {pane === "product" && current && <Modal key="product" title={current.nome} onClose={() => setPane(returnToBag ? "bag" : null)} kind="product-modal">
      <ProductForm product={current} products={products} initial={editing} onSave={addLine} />
    </Modal>}
    {pane === "bag" && <Modal key="bag" title="Sua sacola" onClose={closePane} kind="drawer">
      <div className="modal-body bag-body">
        {!cart.length ? <Empty title="Sua sacola está vazia">Escolha um lanche no cardápio para começar.</Empty> : <>
          {cart.map(line => {
            const product = products.find(p => p.id === line.product);
            if (!product) return null;
            const variant = product.variantes.find(v => v.id === line.variant);
            const details = [variant?.rotulo, line.press, ...line.extras.map(id => products.find(p => p.id === id)?.nome)].filter(Boolean).join(" · ");
            return <div className="bag-line" key={line.key}>
              <div className="bag-line-head"><strong>{product.nome}</strong><strong>{money(linePrice(line, products))}</strong></div>
              {details && <p>{details}</p>}{line.note && <p>Obs. {line.note}</p>}
              <div className="bag-line-actions">
                <Quantity value={line.quantity} onChange={quantity => changeCart(cart.map(item => item.key === line.key ? { ...item, quantity } : item))} />
                <button className="inline-action" onClick={() => selectProduct(product, line)}>Editar</button>
                <button className="icon-button remove" aria-label={`Remover ${product.nome}`} onClick={() => changeCart(cart.filter(item => item.key !== line.key))}><Trash2 size={18} /></button>
              </div>
            </div>;
          })}
          {suggestion && !cart.some(item => item.product === suggestion.id) && <button className="suggestion" onClick={() => selectProduct(suggestion)}>
            <span><strong>Acompanhe com uma bebida</strong><small>{suggestion.nome} · {money(suggestion.preco_centavos)}</small></span><Plus size={20} />
          </button>}
          {unavailable && <p className="notice">Há um item ou complemento esgotado. Edite a sacola para continuar.</p>}
          {paused && <p className="notice">Novos pedidos estão pausados.</p>}
        </>}
      </div>
      <div className="modal-foot">
        {cart.length ? <><div className="summary"><span>Subtotal</span><strong>{money(total)}</strong></div>
          <button className="button button-primary full" disabled={paused || unavailable} onClick={() => setPane("checkout")}>Escolher retirada <ArrowRight size={20} /></button></>
          : <button className="button button-primary full" onClick={() => { setPane(null); document.getElementById("cardapio")?.scrollIntoView(); }}>Ver cardápio <ArrowDownRight size={20} /></button>}
      </div>
    </Modal>}
    {pane === "checkout" && <Modal key="checkout" title="Retirada e checkout" onClose={closePane} kind="checkout-modal">
      <Checkout cart={cart} total={total} campaign={campaign} commercial={commercial} initialMode={mode} onBack={() => setPane("bag")} onBusy={setSubmitting} onChange={syncStore}
        onDone={order => {
          rememberOrder(order);
          if (order.payment === "aprovado" || order.payment === "pendente") changeCart([]);
          setPane(null);
          window.location.assign(`/pedido/${order.tracking}`);
        }} />
    </Modal>}
  </>;
}

function ProductCard({ product, onSelect }: { product: Product; onSelect: () => void }) {
  const category = categories.find(c => c.id === product.categoria);
  return <article className={`product-card ${product.disponivel === false ? "sold-out" : ""}`}>
    {product.foto && <img className="product-photo" src={product.foto} alt={product.nome} loading="lazy" />}
    <div className="product-top"><span><CategoryIcon category={product.categoria} size={16} /> {category?.nome}</span>{product.disponivel === false && <b>Esgotado</b>}</div>
    <button className="product-title" onClick={onSelect}>{product.nome}</button>
    {product.descricao_fonte && <p>{product.descricao_fonte.replace(/^Prensado ou sem prensar,\s*/i, "")}</p>}
    <div className="product-bottom"><div>{product.variantes.length > 0 && <small>A partir de</small>}<strong>{money(product.preco_centavos)}</strong></div>
      <button type="button" className="add-button" aria-label={`Abrir ${product.nome}`} onClick={onSelect}><Plus size={23} /></button>
    </div>
  </article>;
}

function Quantity({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="quantity" aria-label="Quantidade">
    <button type="button" aria-label="Diminuir quantidade" disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus size={16} /></button><output aria-live="polite">{value}</output>
    <button type="button" aria-label="Aumentar quantidade" disabled={value >= 15} onClick={() => onChange(value + 1)}><Plus size={16} /></button>
  </div>;
}

function ProductForm({ product, products, initial, onSave }: { product: Product; products: Product[]; initial: CartLine | null; onSave: (line: CartLine) => void }) {
  const [variant, setVariant] = useState(initial?.variant ?? product.variantes[0]?.id ?? "");
  const [press, setPress] = useState(initial?.press ?? (product.categoria === "dogoes" ? "Prensado" : ""));
  const [extras, setExtras] = useState(initial?.extras ?? []);
  const [quantity, setQuantity] = useState(initial?.quantity ?? 1);
  const [note, setNote] = useState(initial?.note ?? "");
  const options = extrasFor(product, products);
  const line = { key: initial?.key ?? "", product: product.id, variant, press, extras: [...extras].sort(), quantity, note: note.trim() };
  const soldOut = product.disponivel === false;
  const hasSoldOutExtra = extras.some(id => options.find(extra => extra.id === id)?.disponivel === false);
  return <form onSubmit={event => { event.preventDefault(); onSave({ ...line, key: line.key || crypto.randomUUID() }); }} className="modal-form">
    <div className="modal-body form-stack">
      {product.foto && <img className="product-detail-photo" src={product.foto} alt={product.nome} />}
      {product.descricao_fonte && <p className="product-description">{product.descricao_fonte}</p>}
      {soldOut && <p className="notice">Este item está esgotado na demonstração.</p>}
      {product.variantes.length > 0 && <fieldset><legend>Escolha a versão</legend><div className="choice-grid">
        {product.variantes.map(v => <label className="choice" key={v.id}><input type="radio" name="variant" checked={variant === v.id} onChange={() => setVariant(v.id)} /><span>{v.rotulo}</span><strong>{money(v.preco_centavos)}</strong></label>)}
      </div></fieldset>}
      {product.categoria === "dogoes" && <fieldset><legend>Como você prefere?</legend><div className="choice-grid">{["Prensado", "Sem prensar"].map(value => <label className="choice" key={value}><input type="radio" name="press" checked={press === value} onChange={() => setPress(value)} /><span>{value}</span></label>)}</div></fieldset>}
      {options.length > 0 && <fieldset><legend>Complementos <small>opcional</small></legend><div className="extras-list">
        {options.map(extra => <label key={extra.id} className={`extra-row ${extra.disponivel === false && !extras.includes(extra.id) ? "extra-unavailable" : ""}`}>
          <input type="checkbox" checked={extras.includes(extra.id)} disabled={extra.disponivel === false && !extras.includes(extra.id)}
            onChange={event => setExtras(event.target.checked ? [...extras, extra.id] : extras.filter(id => id !== extra.id))} />
          <span>{extra.nome}{extra.disponivel === false && <small> · Esgotado</small>}</span><strong>+ {money(extra.preco_centavos)}</strong>
        </label>)}
      </div></fieldset>}
      <label className="field"><span>Observação <small>opcional</small></span><textarea value={note} onChange={event => setNote(event.target.value)} maxLength={180} rows={2} placeholder={product.id === "nuggets" ? "Indique o molho desejado" : "Informe apenas detalhes do preparo"} /></label>
    </div>
    <div className="modal-foot product-actions"><Quantity value={quantity} onChange={setQuantity} />
      <button className="button button-primary" disabled={soldOut || hasSoldOutExtra}>{initial ? "Salvar item" : "Adicionar"} <span>{money(linePrice(line, products))}</span></button>
    </div>
  </form>;
}

function Checkout({ cart, total, campaign, commercial, initialMode, onBack, onBusy, onDone, onChange }: {
  cart: CartLine[]; total: number; campaign: string | null; commercial: CommercialInfo | null; initialMode: Mode;
  onBack: () => void; onBusy: (value: boolean) => void;
  onDone: (order: Order) => void; onChange: () => Promise<void>;
}) {
  const [retry, setRetry] = useState<CheckoutRequest | null>(() => pendingCheckoutAttempt(cart));
  const [pickup, setPickup] = useState<Pickup>(retry?.pickup ?? "imediata");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState("");
  const [day, setDay] = useState(retry?.slot ? dateKey(retry.slot) : "");
  const [slot, setSlot] = useState<number | null>(retry?.slot ?? null);
  const [name, setName] = useState(retry?.customer ?? "");
  const [method, setMethod] = useState<Method>(retry?.method ?? "Pix");
  const [scenario, setScenario] = useState<Scenario>(retry?.scenario ?? "aprovado");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const checkoutMode = retry ? retry.mode ?? "demo" : mode;
  const demo = checkoutMode === "demo";

  async function fetchSlots() {
    setLoading(true);
    try {
      const data = await api<{ slots: Slot[]; paused: boolean; ready: boolean; mode: Mode }>("horarios", undefined, AbortSignal.timeout(10_000));
      setPaused(data.paused);
      setReady(data.ready);
      setMode(data.mode);
      setSlots(data.slots);
      setScheduleError("");
    } catch (problem) { setScheduleError(errorMessage(problem)); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const initial = setTimeout(() => { void fetchSlots(); }, 0);
    return () => clearTimeout(initial);
  }, []);
  const days = useMemo(() => [...new Map(slots.map(s => [dateKey(s.start), dayLabel(s.start)])).entries()], [slots]);
  const next = slots.find(s => s.remaining > 0);
  const activeDay = day || (next ? dateKey(next.start) : days[0]?.[0]) || "";
  const daySlots = slots.filter(s => dateKey(s.start) === activeDay);
  const activeSlot = slot === null ? daySlots.find(s => s.remaining > 0) : daySlots.find(s => s.start === slot);
  const chosen = pickup === "imediata" ? next : activeSlot && activeSlot.remaining > 0 ? activeSlot : undefined;
  const unavailableSlot = pickup === "agendada" && slot !== null && !chosen;

  const canSend = Boolean(retry || (chosen && !loading && ready && !paused && !scheduleError));
  const lockFields = busy || Boolean(retry);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend || sending.current) return;
    sending.current = true;
    if (!retry && pickup === "agendada" && chosen) {
      setDay(activeDay);
      setSlot(chosen.start);
    }
    setBusy(true);
    onBusy(true);
    setError("");

    let request = retry;
    let order: Order;
    try {
      if (!request) {
        const draft = {
          customer: name.trim(), pickup,
          slot: pickup === "agendada" ? chosen?.start ?? null : null,
          items: cart, total, campaign,
        };
        request = startCheckoutAttempt(checkoutMode === "demo" ? { ...draft, mode: checkoutMode, method, scenario } : { ...draft, mode: checkoutMode });
      }
      order = await api<Order>("pedido", request, AbortSignal.timeout(checkoutResponseTimeoutMs));
    } catch (problem) {
      const rejected = problem instanceof ApiError && problem.status >= 400 && problem.status < 500
        && problem.status !== 408 && problem.status !== 429;
      if (request && !rejected) {
        setRetry(request);
      } else {
        if (request) finishCheckoutAttempt(request.requestKey);
        setRetry(null);
        setError(errorMessage(problem));
        await Promise.all([fetchSlots(), onChange()]);
      }
      sending.current = false;
      setBusy(false);
      onBusy(false);
      return;
    }

    onDone(order);
    finishCheckoutAttempt(request.requestKey);
    onBusy(false);
  }

  return <form className="modal-form" onSubmit={submit}>
    <div className="modal-body form-stack checkout-body">
      <button type="button" className="inline-action back-action" onClick={onBack} disabled={busy}><ArrowLeft size={16} /> Voltar à sacola</button>
      <div className="notice demo-notice"><CreditCard size={21} /><div><strong>{demo ? "Checkout demonstrativo" : checkoutMode === "teste" ? "Homologação Mercado Pago" : "Checkout Mercado Pago"}</strong>
        <p>{demo ? "Simulador com Pix e cartão. Use um apelido e detalhes de teste."
          : checkoutMode === "teste" ? "Use a conta de teste compradora. Você tem cinco minutos para concluir o pagamento de teste."
          : "Reserve a janela e conclua o pagamento no Mercado Pago em até cinco minutos."}</p></div></div>
      <label className="field"><span>Nome ou apelido para retirada</span><input required minLength={2} maxLength={60} disabled={lockFields} value={name} onChange={event => setName(event.target.value)} placeholder="Ex. Alex" autoComplete="off" /></label>
      <fieldset disabled={lockFields}><legend>Quando você quer retirar?</legend><div className="choice-grid pickup-choices">
        <label className="choice"><input type="radio" name="pickup" checked={pickup === "imediata"} onChange={() => setPickup("imediata")} /><span><strong><Clock3 size={16} /> Próxima vaga</strong><small>Retirada imediata</small></span></label>
        <label className="choice"><input type="radio" name="pickup" checked={pickup === "agendada"} onChange={() => setPickup("agendada")} /><span><strong><CalendarClock size={16} /> Agendar</strong><small>Escolha uma janela</small></span></label>
      </div></fieldset>
      {retry ? (retry.slot !== null && <div className="estimate"><Clock3 size={18} /><div><strong>{dayLabel(retry.slot)} · {windowLabel(retry.slot)}</strong><small>Janela do envio anterior</small></div></div>) :
        loading ? <p className="muted" role="status">Buscando janelas de retirada…</p> :
        paused ? <p className="notice">A Kombi pausou novos pedidos.</p> :
        scheduleError ? <p className="notice notice-error" role="alert">{scheduleError} <button type="button" className="inline-action" onClick={() => fetchSlots()}>Recarregar horários</button></p> :
        !ready ? <p className="notice">O checkout ainda não está liberado neste ambiente.</p> :
        !next ? <p className="notice">Nenhuma vaga disponível nos próximos sete dias.</p> :
        pickup === "imediata" ? <div className="estimate"><Clock3 size={18} /><div><strong>{dayLabel(next.start)} · {windowLabel(next.start)}</strong><small>Janela estimada para retirada · horário de São Paulo</small></div></div> :
        <>
          <div className="checkout-times">
            <label className="field"><span>Dia da retirada</span><select disabled={lockFields} value={activeDay} onChange={event => { setDay(event.target.value); setSlot(null); }}>
              {day && !days.some(([key]) => key === day) && <option value={day} disabled>Dia indisponível</option>}
              {days.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label className="field"><span>Janela de 15 minutos</span><select disabled={lockFields} value={slot ?? activeSlot?.start ?? ""} onChange={event => { setDay(activeDay); setSlot(Number(event.target.value)); }}>
              {slot !== null && !activeSlot && <option value={slot} disabled>{windowLabel(slot)} · Indisponível</option>}
              {slot === null && !activeSlot && <option value="">Escolha outro dia</option>}
              {daySlots.map(s => <option key={s.start} value={s.start} disabled={!s.remaining}>{windowLabel(s.start)} · {s.remaining ? `${s.remaining} ${s.remaining === 1 ? "vaga" : "vagas"}` : "Lotado"}</option>)}
            </select></label>
          </div>
          {unavailableSlot && <p className="notice" role="status">A janela escolhida ficou indisponível. Selecione outro horário.</p>}
        </>}
      {demo && <div className="checkout-times">
        <label className="field"><span>Forma de pagamento de teste</span><select disabled={lockFields} value={method} onChange={event => setMethod(event.target.value as Method)}><option>Pix</option><option>Cartão</option></select></label>
        <label className="field"><span>Resultado da simulação</span><select disabled={lockFields} value={scenario} onChange={event => setScenario(event.target.value as Scenario)}>{(["aprovado", "pendente", "recusado", "expirado"] as const).map(p => <option value={p} key={p}>{payments[p]}</option>)}</select></label>
      </div>}
      {demo && scenario === "pendente" && <p className="muted">A reserva de teste expira em cinco minutos. Você pode simular a aprovação na página do pedido.</p>}
      {checkoutMode === "producao" && commercial && <details className="order-events"><summary>Vendedor e políticas <ChevronDown size={16} /></summary>
        <p className="muted">{commercial.seller} · {commercial.identification} · {commercial.contact}</p>
        <a className="inline-action" href="/#dados-comerciais" target="_blank" rel="noreferrer">Consultar dados comerciais e políticas</a>
      </details>}
      {retry && <p className="notice" role="status">O envio anterior pode ter sido registrado. Reenvie para conferir o mesmo pedido.</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
    </div>
    <div className="modal-foot"><div className="summary"><span>{checkoutMode === "producao" ? "Total" : "Total de teste"}</span><strong>{money(retry?.total ?? total)}</strong></div><button type="submit" className="button button-primary full" disabled={busy || !canSend}>{busy ? "Registrando pedido…" : retry ? "Reenviar pedido" : demo ? "Simular pedido" : "Reservar e continuar"} <ArrowRight size={19} /></button></div>
  </form>;
}
