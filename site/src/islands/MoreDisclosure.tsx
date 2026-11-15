// A long list tucked behind a Disclosure. The content is server-rendered
// HTML passed in as children; without JS a <noscript> rule in Base.astro
// shows the panel open.
import type { ReactNode } from "react";
import { Button, Disclosure, DisclosurePanel, Heading } from "react-aria-components";

export default function MoreDisclosure({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Disclosure className="disclosure">
      <Heading level={3} className="disclosure-heading">
        <Button slot="trigger" className="disclosure-trigger">
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="chevron">
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          {title}
        </Button>
      </Heading>
      <DisclosurePanel className="disclosure-panel">{children}</DisclosurePanel>
    </Disclosure>
  );
}
