// One state's members of Congress, summarized for the member finder's results.
import { delegations, delegationFile, stateSlug, type Delegation } from "../../../lib/districts";
import { stateList } from "../../../lib/bluesky";

export function getStaticPaths() {
  return delegations.map((d) => ({ params: { state: stateSlug(d.state) }, props: { d } }));
}

export function GET({ props }: { props: { d: Delegation } }) {
  return new Response(JSON.stringify(delegationFile(props.d, stateList(props.d.state)?.url)));
}
