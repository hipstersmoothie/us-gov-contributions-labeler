// One state's delegation as Bluesky profile cards, for the hub's member
// finder: it loads a state when someone picks it.
import { members } from "../../../lib/data";
import { cardRow } from "../../../lib/bluesky-hub";

export function getStaticPaths() {
  return [...new Set(members.map((m) => m.state))].map((state) => ({ params: { state } }));
}

export function GET({ params }: { params: { state: string } }) {
  return new Response(JSON.stringify(members.filter((m) => m.state === params.state).map(cardRow)));
}
