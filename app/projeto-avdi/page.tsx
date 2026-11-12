import type { Metadata } from "next";
import { ArrowLeft, Camera, ImagePlus, Palette } from "lucide-react";
import { originalProducts, students, type Submission } from "@/lib/federal";
import { getSubmissions } from "@/lib/federal-server";
import { Campaign, SiteFooter, SiteHeader } from "../site-ui";

export const metadata: Metadata = { title: "Projeto AVDI", description: "Anúncio, escolhas de design e trabalhos individuais do Food Truck Federal." };
export const dynamic = "force-dynamic";

const choices = [
  ["Referências", "A sinalização de lanchonetes de rua e o letreiro da própria Kombi inspiraram as letras condensadas e as faixas quadriculadas."],
  ["Figura e fundo", "O creme dá respiro aos textos e deixa o vermelho da Kombi dominar a fotografia. No anúncio, o fundo vinho destaca o lanche."],
  ["Grade e ritmo", "A abertura é assimétrica. O cardápio volta a uma grade regular para facilitar a comparação de nomes, preços e opções."],
  ["Cor e tipografia", "Vermelho e amarelo vêm da marca. Barlow Condensed concentra a atenção nos títulos e DM Sans mantém legíveis os ingredientes e controles."],
  ["Arquétipos", "Pessoa Comum orienta o tom direto. Cuidador aparece na clareza da retirada e no acompanhamento de cada etapa."],
  ["Fotografia e narrativa", "Fotos da equipe mostram a Kombi e o dogão. A navegação começa no ponto de venda, passa pela escolha do lanche e termina no balcão."],
];

export default async function Page() {
  let submissions: Submission[];
  try { submissions = await getSubmissions(); }
  catch { submissions = students.map(s => ({ ...s, original: null, edited: null })); }
  return <><SiteHeader /><main className="container page-shell avdi">
    <a className="back-link" href="/"><ArrowLeft size={17} /> Voltar ao site comercial</a>
    <section className="avdi-intro">
      <div><span className="eyebrow">Trabalho final · 4º bimestre</span><h1>Projeto <em>AVDI.</em></h1><p>Um site de vendas para o Food Truck Federal, comércio independente em frente ao IFSP. O projeto combina a identidade da Kombi com uma jornada de pedido antecipado voltada a estudantes e à comunidade do entorno.</p><div className="team">{students.map(({ student }) => <span key={student}>{student}</span>)}</div></div>
      <div className="avdi-brand"><img src="/media/marca-original.webp" alt="Arte original da marca com ilustração da Kombi" width="750" height="330" /><small>Referência visual da marca. Ano de fundação a confirmar.</small></div>
    </section>

    <section className="avdi-section" aria-labelledby="direcao"><div className="section-title"><span className="eyebrow"><Palette size={17} /> Direção de arte</span><h2 id="direcao">O visual da Kombi no site.</h2></div>
      <div className="directions">
        <article className="direction classic"><span>Federal Clássico · identidade do site</span><strong>Seu lanche<br /><em>sem fila.</em></strong><div className="palette"><i /><i /><i /><i /></div></article>
        <article className="direction street"><span>Federal Street · estudo alternativo</span><strong>Da Kombi<br /><em>pra rua.</em></strong><img src="/media/kombi.webp" alt="" loading="lazy" /></article>
      </div>
      <div className="avdi-rationale">{choices.map(([title, copy]) => <article key={title}><h3>{title}</h3><p>{copy}</p></article>)}</div>
    </section>

    <section className="avdi-section" aria-labelledby="avdi-campanha"><div className="section-title"><span className="eyebrow">Trabalho em grupo</span><h2 id="avdi-campanha">Anúncio publicitário</h2></div><Campaign standalone /></section>

    <section className="avdi-section" aria-labelledby="individual"><div className="section-title"><span className="eyebrow">Trabalhos individuais</span><h2 id="individual">Quatro produtos, quatro olhares.</h2><p>Os produtos abaixo são propostas de atribuição. A foto original e a edição por IA do mesmo item podem ser publicadas pelo painel autorizado.</p></div>
      <div className="submission-grid">
        {submissions.map(item => {
          const product = originalProducts.find(p => p.id === item.product);
          const complete = Boolean(item.original && item.edited);
          return <article className="panel submission" key={item.student}>
            <div className="submission-head"><div><span className="eyebrow">{item.student}</span><h3>{product?.nome}</h3></div><span className={`state-badge ${complete ? "stage-retirado" : "stage-recebido"}`}>{complete ? "Par publicado" : "Par pendente"}</span></div>
            <div className="pair-grid"><PhotoSide src={item.original} name="Foto original" /><PhotoSide src={item.edited} name="Versão editada por IA" /></div>
          </article>;
        })}
      </div>
      <div className="panel photo-example"><div><span className="eyebrow">Estudo de fotografia</span><h3>Um dogão, duas leituras.</h3><p>A edição por IA trabalhou o fundo e a luz a partir da foto real. A receita específica do dogão precisa ser confirmada para associar este par ao cardápio.</p></div>
        <div className="pair-grid"><PhotoSide src="/media/dogao-original.webp" name="Foto original" /><PhotoSide src="/media/dogao-ia.webp" name="Versão editada por IA" /></div>
      </div>
    </section>
  </main><SiteFooter /></>;
}

function PhotoSide({ src, name }: { src: string | null; name: string }) {
  const Icon = name === "Foto original" ? Camera : ImagePlus;
  return <figure className="photo-side">
    {src ? <img src={src} alt={name} loading="lazy" /> : <div className="photo-missing"><Icon size={24} /><span>Foto pendente</span></div>}
    <figcaption>{name}</figcaption>
  </figure>;
}
