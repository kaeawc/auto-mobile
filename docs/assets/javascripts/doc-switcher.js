// Reusable markup:
// <div class="doc-switcher" data-doc-switcher="example">
//   <button data-doc-switcher-option="first">First</button>
//   <button data-doc-switcher-option="second">Second</button>
// </div>
// <div data-doc-switcher-panel="example" data-doc-switcher-value="first">…</div>
// <div data-doc-switcher-panel="example" data-doc-switcher-value="second">…</div>
// Repeat the switcher anywhere on the page to keep controls synchronized.
(() => {
  const switchers = document.querySelectorAll("[data-doc-switcher]");
  if (switchers.length === 0) return;

  const selectorValue = (value) => CSS.escape(value);

  const setSelection = (group, value) => {
    const panels = document.querySelectorAll(`[data-doc-switcher-panel="${selectorValue(group)}"]`);
    const controls = document.querySelectorAll(
      `[data-doc-switcher="${selectorValue(group)}"] [data-doc-switcher-option]`,
    );

    for (const panel of panels) {
      panel.hidden = panel.dataset.docSwitcherValue !== value;
    }
    for (const control of controls) {
      control.setAttribute("aria-pressed", String(control.dataset.docSwitcherOption === value));
    }

    sessionStorage.setItem(`autoMobileDocSwitcher:${group}`, value);
  };

  for (const switcher of switchers) {
    const group = switcher.dataset.docSwitcher;
    if (!group) continue;

    const controls = switcher.querySelectorAll("[data-doc-switcher-option]");
    const defaultValue =
      switcher.dataset.docSwitcherDefault || controls[0]?.dataset.docSwitcherOption;
    if (!defaultValue) continue;

    for (const control of controls) {
      control.addEventListener("click", () => {
        setSelection(group, control.dataset.docSwitcherOption);
      });
    }

    setSelection(group, sessionStorage.getItem(`autoMobileDocSwitcher:${group}`) || defaultValue);
  }
})();
