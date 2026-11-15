import { tradeRows } from "../../lib/holdings";

// Every trade the /holdings/ table shows. Not a dataset offered for reuse:
// it carries the statute's limits on what the reports may be used for.
export function GET() {
  return new Response(
    JSON.stringify({
      notice:
        "From U.S. House financial disclosure reports. Under 5 U.S.C. § 13107 it is unlawful to obtain or use these reports for any unlawful purpose; for any commercial purpose, other than by news and communications media for dissemination to the general public; to determine or establish anyone's credit rating; or, directly or indirectly, to solicit money for any political, charitable or other purpose. Not offered under CC0. Values are reported ranges.",
      rows: tradeRows(),
    })
  );
}
