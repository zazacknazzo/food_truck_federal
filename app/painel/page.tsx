import type { Metadata } from "next";
import { headers } from "next/headers";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { isOperator } from "@/lib/federal-server";
import { chatGPTSignInPath } from "../chatgpt-auth";
import { SiteFooter, SiteHeader } from "../site-ui";
import Dashboard from "./dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Painel da proprietária", robots: { index: false } };

export default async function Page() {
  const identity = await headers();
  if (isOperator(identity)) return <Dashboard />;
  return <><SiteHeader /><main className="container narrow page-shell">
    <a className="back-link" href="/"><ArrowLeft size={17} /> Voltar ao site</a>
    <div className="panel access-panel"><LockKeyhole size={32} /><h1>Painel da proprietária</h1><p>O acesso à fila, ao catálogo e às configurações exige uma conta ChatGPT autorizada pela operação.</p>
      {!identity.get("oai-authenticated-user-id") && <a href={chatGPTSignInPath("/painel")} target="_top" className="button button-primary">Entrar com ChatGPT</a>}
    </div>
  </main><SiteFooter /></>;
}
