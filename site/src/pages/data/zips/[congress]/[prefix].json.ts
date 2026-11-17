// The member finder's ZIP table, one file per three-digit prefix, loaded
// only when someone looks up a ZIP that starts with it.
import { CONGRESS, zipFiles } from "../../../../lib/districts";
import type { ZipFile } from "../../../../islands/find/types";

export function getStaticPaths() {
  return [...zipFiles()].map(([prefix, file]) => ({ params: { congress: String(CONGRESS), prefix }, props: { file } }));
}

export function GET({ props }: { props: { file: ZipFile } }) {
  return new Response(JSON.stringify(props.file));
}
