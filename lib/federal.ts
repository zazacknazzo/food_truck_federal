import source from "./catalogo.json";

export type Product = {
  id: string;
  nome: string;
  categoria: string;
  descricao_fonte: string;
  preco_centavos: number;
  variantes: { id: string; rotulo: string; preco_centavos: number }[];
  foto: string | null;
  disponivel: boolean | null;
  revisar_com_proprietaria: boolean;
  fonte: string;
  observacoes: string[];
};

export const categories = source.categorias;
export const originalProducts: Product[] = source.produtos;
export const featured = ["dog-completo", "dog-4-queijos-bacon", "dog-especial-egg", "x-salada-bacon", "batata-frita-completa", "refrigerante-lata"];
export const students = [
  { student: "Isaac", product: "dog-completo" },
  { student: "Valones", product: "x-salada-bacon" },
  { student: "Lucas", product: "batata-frita-completa" },
  { student: "Felipe", product: "milk-shake-acai-400ml" },
];
export const locationText = "Em frente ao IFSP · Campus São Paulo";
export const mapsUrl = "https://www.google.com/maps/search/?api=1&query=IFSP+Campus+S%C3%A3o+Paulo+Rua+Pedro+Vicente";
export const demoUrl = "https://food-truck-federal.isaacbatistadeolivei.chatgpt.site";
export const campaignPath = "/?utm_source=cartaz&utm_campaign=federal-avdi#cardapio";

export type DayHours = { open: boolean; start: string; end: string };
export type SlotOverride = { date: string; start: string; end: string; capacity: number };
export type Mode = "demo" | "teste" | "producao";
export type MercadoPagoMode = Exclude<Mode, "demo">;
export const modes = { demo: "Demonstração", teste: "Teste Mercado Pago", producao: "Operação comercial" } as const;

export const commercialFields = [
  { key: "seller", label: "Nome do vendedor", limit: 120 },
  { key: "identification", label: "Identificação pública do vendedor", limit: 120 },
  { key: "contact", label: "Contato para atendimento", limit: 200 },
  { key: "address", label: "Endereço da Kombi", limit: 240 },
  { key: "servicePolicy", label: "Política de atendimento", limit: 2500 },
  { key: "cancellationPolicy", label: "Política de cancelamento", limit: 2500 },
  { key: "privacyPolicy", label: "Política de privacidade", limit: 2500 },
] as const;
export type CommercialInfo = Record<typeof commercialFields[number]["key"], string> & { reviewed: boolean };
export const emptyCommercialInfo: CommercialInfo = {
  seller: "", identification: "", contact: "", address: "", servicePolicy: "",
  cancellationPolicy: "", privacyPolicy: "", reviewed: false,
};
export function commercialInfoReady(info: CommercialInfo) {
  return info.reviewed && commercialFields.every(({ key }) => info[key].trim().length > 0);
}
export type Config = {
  paused: boolean; capacity: number; leadMinutes: number; hours: DayHours[];
  overrides: SlotOverride[]; commercial: CommercialInfo;
};
export const defaultConfig: Config = {
  paused: false,
  capacity: 10,
  leadMinutes: 10,
  hours: Array.from({ length: 7 }, (_, i) => ({ open: i !== 0, start: "10:00", end: "22:00" })),
  overrides: [],
  commercial: emptyCommercialInfo,
};
export const weekdays = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
export const zone = "America/Sao_Paulo";
export const slotMs = 15 * 60_000;
export const stages = {
  aguardando_pagamento: "Aguardando pagamento",
  recebido: "Recebido",
  em_preparo: "Em preparo",
  pronto: "Pronto",
  retirado: "Retirado",
  cancelado: "Cancelado",
} as const;
export const payments = {
  aprovado: "Aprovado",
  pendente: "Pendente",
  recusado: "Recusado",
  expirado: "Expirado",
  estorno_solicitado: "Estorno solicitado",
  reembolsado: "Reembolsado",
  em_revisao: "Pagamento em revisão",
} as const;
export const steps = ["recebido", "em_preparo", "pronto", "retirado"] as const;
export type Stage = keyof typeof stages;
export type Payment = keyof typeof payments;
export type Scenario = "aprovado" | "pendente" | "recusado" | "expirado";
export type Pickup = "imediata" | "agendada";
export type Method = "Pix" | "Cartão";
export type Slot = { start: number; remaining: number; capacity: number };
export type CartLine = {
  key: string;
  product: string;
  variant: string;
  press: string;
  extras: string[];
  quantity: number;
  note: string;
};
export type Item = {
  product: string;
  name: string;
  variant: string;
  press: string;
  extras: { name: string; price: number }[];
  quantity: number;
  note: string;
  unit: number;
  total: number;
};
export type Order = {
  demo: boolean;
  mode: Mode;
  id: string;
  tracking?: string;
  code?: string;
  customer: string;
  slot: number;
  pickup: Pickup;
  items: Item[];
  total: number;
  method: Method | "Mercado Pago";
  payment: Payment;
  stage: Stage;
  campaign?: string | null;
  created_at: number;
  expires_at: number | null;
  started_at: number | null;
  ready_at: number | null;
  picked_at: number | null;
  events?: { label: string; at: number }[];
};
export type Submission = { student: string; product: string; original: string | null; edited: string | null };
export type PublishedSubmission = Submission & { photoStatus: "pendente" | "publicado" | "indisponivel" | "revisar" };
export type Metrics = {
  count: number;
  approved: number;
  value: number;
  average: number;
  prepMinutes: number | null;
  top: { name: string; quantity: number }[];
  occupancy: { start: number; count: number; capacity: number }[];
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const clock = new Intl.DateTimeFormat("pt-BR", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat("pt-BR", { timeZone: zone, weekday: "short", day: "2-digit", month: "2-digit" });
const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });

export function money(cents: number) { return currency.format(cents / 100); }
export function time(ms: number) { return clock.format(ms); }
export function dayLabel(ms: number) { return day.format(ms); }
export function dateKey(ms: number) { return date.format(ms); }
export function windowLabel(ms: number) { return `${time(ms)}–${time(ms + slotMs)}`; }
export function orderLabel(id: string) { return `FT-${id.slice(0, 8).toUpperCase()}`; }
export function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}
export function extrasFor(product: Product, products: Product[]) {
  if (!["dogoes", "hamburgueres"].includes(product.categoria) || product.id === "x-salada-vegano") return [];
  return products.filter(p => p.categoria === "complementos" && (product.id !== "x-salada-vegetariano" || ["cheddar", "mussarela", "ovo"].includes(p.id)));
}
export function linePrice(line: CartLine, products: Product[]) {
  const product = products.find(p => p.id === line.product);
  const variant = product?.variantes.find(v => v.id === line.variant);
  const extras = line.extras.reduce((sum, id) => sum + (products.find(p => p.id === id)?.preco_centavos ?? 0), 0);
  return ((variant?.preco_centavos ?? product?.preco_centavos ?? 0) + extras) * line.quantity;
}
