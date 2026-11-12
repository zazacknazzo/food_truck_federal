import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Food Truck Federal · O sabor da Kombi vermelha", template: "%s · Food Truck Federal" },
  description: "Dogões, hambúrgueres, porções e bebidas do Food Truck Federal. Conheça o cardápio e experimente o pedido para retirada na Kombi.",
  icons: { icon: "/favicon.svg" },
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
