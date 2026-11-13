import type { Metadata } from "next";
import { checkoutMode } from "@/lib/federal-runtime";
import { publicCommercialInfo } from "@/lib/federal-server";
import { redirect } from "next/navigation";
import { Tracking } from "../tracking";

export const metadata: Metadata = { title: "Acompanhar pedido", robots: { index: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: {
  params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (/^[a-f0-9]{32}$/.test(token) && Object.keys(await searchParams).length) redirect(`/pedido/${token}`);
  const mode = checkoutMode();
  return <Tracking token={token} mode={mode} commercial={mode === "demo" ? null : await publicCommercialInfo()} />;
}
