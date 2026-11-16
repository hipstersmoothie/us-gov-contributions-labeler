// Custom events for Plausible (loaded in layouts/Base.astro). Counts only:
// props are coarse categories, never what someone typed.
declare global {
  interface Window {
    plausible?: (event: string, options?: { props?: Record<string, string> }) => void;
  }
}

export function track(event: string, props?: Record<string, string>) {
  window.plausible?.(event, props && { props });
}
