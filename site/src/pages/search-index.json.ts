// Everything searchable, for the full results page.
import { fullIndex } from "../lib/search";

export function GET() {
  return new Response(JSON.stringify(fullIndex()));
}
