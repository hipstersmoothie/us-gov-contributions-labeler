import { tradeRows } from "../../lib/holdings";

export function GET() {
  return new Response(JSON.stringify(tradeRows()));
}
