// One shared tooltip for every chart mark carrying data-tip.
(() => {
  const tip = document.getElementById("tooltip");
  if (!tip) return;

  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const { width, height } = tip.getBoundingClientRect();
    const left = Math.min(x + 12, window.innerWidth - width - 8);
    const top = y - height - 12 < 8 ? y + 16 : y - height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  document.addEventListener("pointermove", (e) => {
    const el = e.target instanceof Element && e.target.closest("[data-tip]");
    if (el) show(el, e.clientX, e.clientY);
    else tip.hidden = true;
  });

  document.addEventListener("focusin", (e) => {
    const el = e.target instanceof Element && e.target.closest("[data-tip]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.left, r.top);
  });
  document.addEventListener("focusout", () => (tip.hidden = true));
})();
