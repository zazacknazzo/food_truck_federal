import type { Metadata } from "next";
import { Tracking } from "../tracking";

export const metadata: Metadata = { title: "Acompanhar pedido", robots: { index: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Tracking token={token} />;
}
