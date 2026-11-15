import { orgRows } from "../../lib/rows";

export function GET() {
  return new Response(JSON.stringify(orgRows()));
}
