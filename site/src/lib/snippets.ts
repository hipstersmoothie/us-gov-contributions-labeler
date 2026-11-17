// Copy buttons on a page's code samples (styles/snippets.css). Each copy, by
// button or by selecting the text, is reported with the section it's in (the
// h2 above it) so the page can count it.
export type How = "button" | "selection";

export function copyButtons(report: (pre: Element, section: string, how: How) => void) {
  const sectionOf = new Map<Element, string>();
  let heading = "";
  for (const el of document.querySelectorAll(".prose h2, .prose pre.astro-code")) {
    if (el.tagName === "H2") heading = el.textContent ?? "";
    else sectionOf.set(el, heading);
  }
  const copied = (pre: Element, how: How) => report(pre, sectionOf.get(pre) ?? "", how);

  for (const pre of sectionOf.keys()) {
    const wrap = document.createElement("div");
    wrap.className = "snippet";
    pre.replaceWith(wrap);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent ?? "");
      } catch {
        // No clipboard access: select the code so it can be copied by hand.
        getSelection()?.selectAllChildren(pre);
        return;
      }
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1500);
      copied(pre, "button");
    });
    wrap.append(pre, button);
  }

  document.addEventListener("copy", () => {
    const node = document.getSelection()?.anchorNode;
    const pre = (node instanceof Element ? node : node?.parentElement)?.closest("pre.astro-code");
    if (pre) copied(pre, "selection");
  });
}
