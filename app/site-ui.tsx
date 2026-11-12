"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, Beef, CupSoda, LayoutGrid, MapPin, Menu, PackageOpen,
  ShoppingBag, Sandwich, Shapes, Truck, X,
} from "lucide-react";
import { demoUrl, locationText, mapsUrl } from "@/lib/federal";

export function Brand() {
  return <a href="/" className="brand" aria-label="Food Truck Federal, início">
    <span className="brand-icon" aria-hidden="true"><Truck size={27} strokeWidth={1.9} /></span>
    <span className="brand-type"><small>FOOD TRUCK</small><strong>FEDERAL</strong></span>
  </a>;
}

export function SiteHeader({ bag, onBag, home = false }: { bag?: number; onBag?: () => void; home?: boolean }) {
  const [nav, setNav] = useState(false);
  return <>
    <div className="demo-strip"><div className="container strip-inner"><span><i /> Modo demonstração <span className="strip-detail">· Pedidos e pagamentos de teste</span></span><span className="strip-location"><MapPin size={13} /> Retirada na Kombi · São Paulo</span></div></div>
    <header className="site-header">
      <div className="container header-inner">
        <Brand />
        <nav className={`site-nav ${nav ? "nav-open" : ""}`} aria-label="Navegação principal">
          <a href="/" onClick={() => setNav(false)} className={home ? "nav-current" : ""}>Início</a>
          <a href="/#cardapio" onClick={() => setNav(false)}>Cardápio</a>
          <a href="/#historia" onClick={() => setNav(false)}>Nossa história</a>
          <a className="nav-orders-mobile" href="/pedido" onClick={() => setNav(false)}>Meus pedidos</a>
        </nav>
        <div className="header-actions">
          <a className="header-orders" href="/pedido">Meus pedidos</a>
          {onBag && <button className="bag-button" onClick={onBag} aria-label={`Sacola, ${bag ?? 0} itens`}><ShoppingBag size={18} /><span className="bag-label">Sacola</span><span className="bag-count">{bag ?? 0}</span></button>}
          <button type="button" className="icon-button nav-toggle" aria-label={nav ? "Fechar navegação" : "Abrir navegação"} aria-expanded={nav} onClick={() => setNav(!nav)}>{nav ? <X size={23} /> : <Menu size={23} />}</button>
        </div>
      </div>
    </header>
  </>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div className="container">
      <div className="footer-main">
        <div><Brand /><p>Dogões, hambúrgueres e porções na Kombi vermelha.</p></div>
        <div className="footer-links"><a href="/#cardapio">Cardápio</a><a href="/pedido">Meus pedidos</a><a href={mapsUrl} target="_blank" rel="noreferrer">Ponto de retirada <ArrowUpRight size={14} /></a></div>
        <div className="footer-links"><a href="/projeto-avdi">Projeto AVDI</a><a href="/painel">Painel da proprietária <ArrowUpRight size={14} /></a></div>
      </div>
      <div className="footer-bottom"><span>Comércio independente, em frente ao IFSP · Campus São Paulo.</span><span>Ambiente de demonstração</span></div>
    </div>
  </footer>;
}

export function CategoryIcon({ category, size = 20 }: { category: string; size?: number }) {
  const Icon = { dogoes: Sandwich, hamburgueres: Beef, porcoes: PackageOpen, bebidas: CupSoda, complementos: Shapes }[category] ?? LayoutGrid;
  return <Icon aria-hidden="true" size={size} strokeWidth={1.75} />;
}

export function Modal({ title, onClose, children, kind = "" }: { title: string; onClose: () => void; children: ReactNode; kind?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const saved = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = saved; };
  }, []);
  return <dialog ref={ref} aria-labelledby="modal-title" className={`modal ${kind}`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-content">
      <div className="modal-head"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Fechar" onClick={onClose}><X size={24} /></button></div>
      {children}
    </div>
  </dialog>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><PackageOpen size={28} aria-hidden="true" /><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function Campaign({ standalone = false }: { standalone?: boolean }) {
  const [published, setPublished] = useState(false);
  useEffect(() => { setPublished(window.location.origin === demoUrl); }, []);
  return <section className={`campaign ${standalone ? "campaign-standalone" : ""}`} aria-labelledby="campaign-title">
    <div className="campaign-content">
      <span className="campaign-brand">Food Truck Federal</span>
      <h2 id="campaign-title">Sua fome não precisa esperar <em>na fila.</em></h2>
      <p>Conheça o cardápio da Kombi vermelha e veja como pedir antecipadamente.</p>
      <a className="button button-yellow" href={standalone ? "/#cardapio" : "#cardapio"}>Ver cardápio <ArrowDownRight size={20} /></a>
    </div>
    <div className="campaign-media"><img src="/media/dogao-original.webp" alt="Dogão da Kombi fotografado pela equipe" loading="lazy" width="1280" height="960" /></div>
    {standalone && published && <div className="campaign-download">
      <img src="/media/qr-cardapio.png" width="92" height="92" alt="QR code para o cardápio do site privado" />
      <div><strong>Peças da campanha</strong><p>O QR leva ao cardápio e exige acesso ao site.</p><div className="button-row"><a href="/media/cartaz-federal.png" download>Baixar cartaz <ArrowRight size={15} /></a><a href="/media/story-federal.png" download>Baixar story <ArrowRight size={15} /></a></div></div>
    </div>}
  </section>;
}

export function LocationLink() {
  return <a href={mapsUrl} target="_blank" rel="noreferrer" className="location-link"><MapPin size={20} /> <span>{locationText}</span> <ArrowUpRight size={17} /></a>;
}
