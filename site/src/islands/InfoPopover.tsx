// A small "i" button that opens a definition in a Popover.
import type { ReactNode } from "react";
import { Button, Dialog, DialogTrigger, Heading, OverlayArrow, Popover } from "react-aria-components";

export default function InfoPopover({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <DialogTrigger>
      <Button className="info-button" aria-label={`About: ${title}`}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 7v4.5M8 4.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </Button>
      <Popover className="info-popover" offset={8}>
        <OverlayArrow className="info-arrow">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M0 0l6 6 6-6" /></svg>
        </OverlayArrow>
        <Dialog className="info-dialog">
          <Heading slot="title" className="info-title">{title}</Heading>
          <div className="info-body">{children}</div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
