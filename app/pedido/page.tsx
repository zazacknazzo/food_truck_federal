import type { Metadata } from "next";
import { checkoutMode } from "@/lib/federal-runtime";
import { OrderHistory } from "./tracking";

export const metadata: Metadata = { title: "Meus pedidos", robots: { index: false } };
export const dynamic = "force-dynamic";
export default function Page() { return <OrderHistory mode={checkoutMode()} />; }
