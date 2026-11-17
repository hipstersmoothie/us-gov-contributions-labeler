// A long list behind a Disclosure, fetched the first time it's opened: the
// list is a server-rendered fragment page (`export const partial = true`), so
// it's the same markup the page would have inlined, without the weight on
// every page view. Without JS the panel links to the fragment instead.
import { useEffect, useState } from "react";
import { Button, Disclosure, DisclosurePanel, Heading } from "react-aria-components";

export default function LazyDisclosure({ title, src, what = "list" }: { title: string; src: string; what?: string }) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || html !== undefined) return;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then(setHtml)
      .catch(() => setFailed(true));
  }, [open, html, src]);

  return (
    <Disclosure className="disclosure" isExpanded={open} onExpandedChange={setOpen}>
      <Heading level={3} className="disclosure-heading">
        <Button slot="trigger" className="disclosure-trigger">
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="chevron">
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          {title}
        </Button>
      </Heading>
      <DisclosurePanel className="disclosure-panel">
        {html !== undefined ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : failed ? (
          <p className="muted small">
            Couldn't load the {what}. <a href={src}>Open it on its own</a>.
          </p>
        ) : open ? (
          <p className="muted small" role="status">
            Loading…
          </p>
        ) : (
          // What the server renders, and so what shows without JS.
          <p className="small">
            <a href={src}>Open the full {what}</a>
          </p>
        )}
      </DisclosurePanel>
    </Disclosure>
  );
}
