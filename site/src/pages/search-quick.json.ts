// The prominent slice of the index the header autocomplete loads on focus.
import { quickIndex } from "../lib/search";

export function GET() {
  return new Response(JSON.stringify(quickIndex()));
}
