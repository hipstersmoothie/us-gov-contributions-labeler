import { billRows } from "../../lib/rows";

export function GET() {
  return new Response(JSON.stringify(billRows()));
}
