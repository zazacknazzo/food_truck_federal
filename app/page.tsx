import { checkoutMode } from "@/lib/federal-runtime";
import Home from "./storefront";

export const dynamic = "force-dynamic";
export default function Page() { return <Home initialMode={checkoutMode()} />; }
