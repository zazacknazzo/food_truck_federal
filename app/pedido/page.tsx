import type { Metadata } from "next";
import { OrderHistory } from "./tracking";

export const metadata: Metadata = { title: "Meus pedidos", robots: { index: false } };
export default function Page() { return <OrderHistory />; }
