/**
 * The prototype web page's only script (#16346). It runs in the browser, so it is self-contained:
 * no imports and no closure over module state, because the page inlines `toString()` of it. It
 * switches between views the host pre-rendered and never runs spec logic. UI state stays in
 * memory: no storage, cookies or URL changes.
 */
/**
 * The scale a zoom step lands on: 50–400 %, except that a fitted scale already below 50 % is
 * never raised, so zooming out never enlarges the preview. Passed into the runtime as an argument,
 * so it is unit-tested and still inlined with the script.
 */
export function prototypeWebZoomScale(current: number, requested: number): number {
  const lower = Math.min(0.5, current);
  return Math.max(lower, Math.min(4, requested));
}

export function prototypeWebPageRuntime(zoomScale: typeof prototypeWebZoomScale): void {
  const doc = document;
  const stage = doc.querySelector<HTMLElement>("[data-stage]");
  const viewport = doc.querySelector<HTMLElement>("[data-viewport]");
  if (!stage || !viewport) {
    return;
  }
  const views = Array.from(doc.querySelectorAll<HTMLElement>("[data-view]"));
  const pick = (name: string) => doc.querySelector<HTMLElement>(`[data-control="${name}"]`);
  const variantSelect = pick("variant") as HTMLSelectElement | null;
  const revisionList = pick("revisions");
  const zoomLabel = pick("zoom-level");
  const state = {
    variant: doc.body.dataset.variant ?? "",
    revision: doc.body.dataset.revision ?? "",
    orientation: "portrait",
    scale: 1,
    x: 0,
    y: 0,
    fit: true,
  };
  const current = () =>
    views.find(
      (view) =>
        view.dataset.variant === state.variant &&
        view.dataset.revision === state.revision &&
        view.dataset.orientation === state.orientation,
    );
  const fitScale = (view: HTMLElement) => {
    const frame = view.firstElementChild as HTMLElement | null;
    if (!frame) {
      return 1;
    }
    const scale = Math.min(
      viewport.clientWidth / frame.offsetWidth,
      viewport.clientHeight / frame.offsetHeight,
    );
    return Math.max(0.1, Math.min(4, scale * 0.95));
  };
  const apply = () => {
    const shown = current();
    views.forEach((view) => {
      view.hidden = view !== shown;
    });
    if (shown && state.fit) {
      state.scale = fitScale(shown);
      state.x = 0;
      state.y = 0;
    }
    stage.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
    }
    revisionList?.querySelectorAll<HTMLElement>("[data-revision-for]").forEach((item) => {
      item.hidden = item.dataset.revisionFor !== state.variant;
      item.setAttribute("aria-pressed", String(item.dataset.revisionValue === state.revision));
    });
  };
  const zoomTo = (scale: number) => {
    state.fit = false;
    state.scale = zoomScale(state.scale, scale);
    apply();
  };
  pick("rotate")?.addEventListener("click", () => {
    state.orientation = state.orientation === "portrait" ? "landscape" : "portrait";
    state.fit = true;
    apply();
  });
  pick("zoom-in")?.addEventListener("click", () => zoomTo(state.scale * 1.25));
  pick("zoom-out")?.addEventListener("click", () => zoomTo(state.scale / 1.25));
  pick("zoom-fit")?.addEventListener("click", () => {
    state.fit = true;
    apply();
  });
  variantSelect?.addEventListener("change", () => {
    state.variant = variantSelect.value;
    const option = variantSelect.selectedOptions[0];
    state.revision = option?.dataset.latest ?? state.revision;
    state.fit = true;
    apply();
  });
  revisionList?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-revision-value]");
    if (target?.dataset.revisionValue) {
      state.revision = target.dataset.revisionValue;
      apply();
    }
  });
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoomTo(state.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | undefined;
  viewport.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX - state.x, y: event.clientY - state.y };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (drag) {
      state.fit = false;
      state.x = event.clientX - drag.x;
      state.y = event.clientY - drag.y;
      apply();
    }
  });
  viewport.addEventListener("pointerup", () => {
    drag = undefined;
  });
  viewport.addEventListener("dblclick", () => {
    state.fit = true;
    apply();
  });
  globalThis.addEventListener("resize", apply);
  apply();
}
