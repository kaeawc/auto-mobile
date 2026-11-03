/**
 * The prototype web page's only script (#16346). It runs in the browser, so it is self-contained:
 * no imports and no closure over module state, because the page inlines `toString()` of it. It
 * switches between views the host pre-rendered and never runs spec logic. UI state stays in
 * memory: no storage, cookies or URL changes. Rotate animates the turn between the two
 * pre-rendered orientations unless the viewer prefers reduced motion.
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

/**
 * The fitted scale: the frame fills 95% of the viewport, capped at 400%, however small the viewport
 * (so the whole frame stays visible). An empty viewport has nothing to fit and falls back to 100%,
 * so zooming can still recover.
 */
export function prototypeWebFitScale(
  viewport: { width: number; height: number },
  frame: { width: number; height: number },
): number {
  const scale = Math.min(viewport.width / frame.width, viewport.height / frame.height);
  return Number.isFinite(scale) && scale > 0 ? Math.min(4, scale * 0.95) : 1;
}

/** The zoom factor one wheel step applies; a horizontal-only gesture (no vertical delta) is none. */
export function prototypeWebWheelFactor(deltaY: number): number | undefined {
  if (deltaY === 0) {
    return undefined;
  }
  return deltaY < 0 ? 1.1 : 1 / 1.1;
}

/**
 * The view to show among one revision's views for one orientation: the chosen screen's, else the
 * first, which is the revision's start screen (or its only view when it has no screen picker).
 */
export function prototypeWebScreenView<View extends { dataset: { screen?: string } }>(
  views: readonly View[],
  screen: string,
): View | undefined {
  return views.find((view) => view.dataset.screen === screen) ?? views[0];
}

/** Where the viewer is among the pre-rendered views' dimensions besides the screen. */
export interface PrototypeWebViewKey {
  readonly variant: string;
  readonly revision: string;
  readonly orientation: string;
  /** Empty for a frame without postures, whose views carry none. */
  readonly posture: string;
}

/** Whether a view belongs to the key: its variant, revision, orientation and posture (#16445). */
export function prototypeWebViewMatches(
  dataset: { readonly [name: string]: string | undefined },
  key: PrototypeWebViewKey,
): boolean {
  return (
    dataset.variant === key.variant &&
    dataset.revision === key.revision &&
    dataset.orientation === key.orientation &&
    (dataset.posture ?? "") === key.posture
  );
}

/** One rotation turn: the keyframes of the view turning away and of the view turning in. */
export interface PrototypeWebRotation {
  readonly durationMs: number;
  readonly easing: string;
  readonly outgoing: Keyframe[];
  readonly incoming: Keyframe[];
}

/**
 * The turn into `to` (#16545). The frame turns 90° counterclockwise into landscape and back
 * clockwise: the outgoing view turns away from upright while the incoming view, drawn in the new
 * orientation, turns from a quarter turn back into place, so both track one frame. Android
 * cross-fades the content over the whole turn; iOS re-lays the content out as the window's bounds
 * animate, so the new layout takes over in the first quarter of the turn.
 */
export function prototypeWebRotation(
  platform: string,
  to: "portrait" | "landscape",
): PrototypeWebRotation {
  const sign = to === "landscape" ? 1 : -1;
  const at = (degrees: number) => `translate(-50%, -50%) rotate(${degrees}deg)`;
  const ios = platform === "ios";
  const handover = ios ? 0.25 : 1;
  return {
    durationMs: ios ? 400 : 500,
    easing: ios ? "ease-in-out" : "cubic-bezier(0.4, 0, 0.2, 1)",
    outgoing: [
      { transform: at(0), opacity: 1, offset: 0 },
      ...(ios ? [{ transform: at(sign * -22.5), opacity: 0, offset: handover }] : []),
      { transform: at(sign * -90), opacity: 0, offset: 1 },
    ],
    incoming: [
      { transform: at(sign * 90), opacity: 0, offset: 0 },
      ...(ios ? [{ transform: at(sign * 67.5), opacity: 1, offset: handover }] : []),
      { transform: at(0), opacity: 1, offset: 1 },
    ],
  };
}

/** The elements one turn moves. */
export interface PrototypeWebTurnTargets {
  readonly from: HTMLElement | undefined;
  readonly shown: HTMLElement | undefined;
  readonly stage: HTMLElement;
  /** The stage's transform before the turn; its current transform is where the turn ends. */
  readonly stageFrom: string;
  /** The view shown when the turn ends; the outgoing view is hidden unless it is that view. */
  readonly current: () => HTMLElement | undefined;
}

/**
 * Starts one turn: the outgoing view stays visible and turns away, the shown view turns in, and
 * the stage's fitted scale follows. Nothing animates when the view did not change or the viewer
 * prefers reduced motion. Returns the turn's animations, so a later turn can finish them.
 */
export function prototypeWebAnimateTurn(
  turn: PrototypeWebRotation,
  targets: PrototypeWebTurnTargets,
): Animation[] {
  const { from, shown, stage, stageFrom, current } = targets;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (!from || !shown || from === shown || reduced || !shown.animate) {
    return [];
  }
  const timing = { duration: turn.durationMs, easing: turn.easing };
  from.hidden = false;
  const outgoing = from.animate(turn.outgoing, timing);
  outgoing.onfinish = () => {
    from.hidden = from !== current();
  };
  return [
    outgoing,
    shown.animate(turn.incoming, timing),
    stage.animate([{ transform: stageFrom }, { transform: stage.style.transform }], timing),
  ];
}

/** The pure rules the runtime is handed as arguments, so they are unit-tested and inlined with it. */
export interface PrototypeWebRuntimeRules {
  readonly zoomScale: typeof prototypeWebZoomScale;
  readonly fitScale: typeof prototypeWebFitScale;
  readonly wheelFactor: typeof prototypeWebWheelFactor;
  readonly screenView: typeof prototypeWebScreenView;
  readonly viewMatches: typeof prototypeWebViewMatches;
  readonly rotation: typeof prototypeWebRotation;
  readonly animateTurn: typeof prototypeWebAnimateTurn;
}

export function prototypeWebPageRuntime(rules: PrototypeWebRuntimeRules): void {
  const { zoomScale, fitScale: fitted, wheelFactor, screenView, viewMatches } = rules;
  const { rotation, animateTurn } = rules;
  const doc = document;
  const stage = doc.querySelector<HTMLElement>("[data-stage]");
  const viewport = doc.querySelector<HTMLElement>("[data-viewport]");
  if (!stage || !viewport) {
    return;
  }
  const views = Array.from(doc.querySelectorAll<HTMLElement>("[data-view]"));
  const pick = (name: string) => doc.querySelector<HTMLElement>(`[data-control="${name}"]`);
  const variantSelect = pick("variant") as HTMLSelectElement | null;
  const screenSelect = pick("screen") as HTMLSelectElement | null;
  const postureSelect = pick("posture") as HTMLSelectElement | null;
  const revisionList = pick("revisions");
  const zoomLabel = pick("zoom-level");
  const bodyData = (name: string) => doc.body.dataset[name] ?? "";
  const state = {
    variant: bodyData("variant"),
    revision: bodyData("revision"),
    orientation: "portrait" as "portrait" | "landscape",
    posture: bodyData("posture"),
    // The first apply sets the shown view's screen.
    screen: "",
    scale: 1,
    x: 0,
    y: 0,
    fit: true,
  };
  const revisionViews = () => views.filter((view) => viewMatches(view.dataset, state));
  const current = () => screenView(revisionViews(), state.screen);
  // The picker lists the shown revision's own screens, so it never offers a view the page lacks.
  // A revision without the chosen screen shows its start, which becomes the chosen screen.
  let listed = "";
  const syncScreens = (shown: HTMLElement | undefined) => {
    state.screen = shown?.dataset.screen ?? state.screen;
    if (!screenSelect) {
      return;
    }
    const key = `${state.variant} ${state.revision}`;
    if (key !== listed) {
      listed = key;
      const screens = revisionViews().flatMap((view) => view.dataset.screen ?? []);
      screenSelect.replaceChildren(...screens.map((screen) => new Option(screen, screen)));
      screenSelect.hidden = screens.length < 2;
    }
    screenSelect.value = state.screen;
  };
  const fitScale = (view: HTMLElement) => {
    const frame = view.firstElementChild as HTMLElement | null;
    if (!frame) {
      return 1;
    }
    return fitted(
      { width: viewport.clientWidth, height: viewport.clientHeight },
      { width: frame.offsetWidth, height: frame.offsetHeight },
    );
  };
  const apply = () => {
    const shown = current();
    syncScreens(shown);
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
  const fitView = () => {
    state.fit = true;
    apply();
  };
  // A new turn finishes the running one first, so turns never overlap.
  let turning: Animation[] = [];
  pick("rotate")?.addEventListener("click", () => {
    turning.forEach((animation) => animation.finish());
    const [from, stageFrom] = [current(), stage.style.transform];
    state.orientation = state.orientation === "portrait" ? "landscape" : "portrait";
    fitView();
    const turn = rotation(doc.body.dataset.platform ?? "", state.orientation);
    turning = animateTurn(turn, { from, shown: current(), stage, stageFrom, current });
  });
  pick("zoom-in")?.addEventListener("click", () => zoomTo(state.scale * 1.25));
  pick("zoom-out")?.addEventListener("click", () => zoomTo(state.scale / 1.25));
  pick("zoom-fit")?.addEventListener("click", fitView);
  variantSelect?.addEventListener("change", () => {
    state.variant = variantSelect.value;
    const option = variantSelect.selectedOptions[0];
    state.revision = option?.dataset.latest ?? state.revision;
    state.fit = true;
    apply();
  });
  postureSelect?.addEventListener("change", () => {
    state.posture = postureSelect.value;
    fitView();
  });
  screenSelect?.addEventListener("change", () => {
    state.screen = screenSelect.value;
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
      // Only vertical wheel input zooms; a horizontal-only gesture passes through.
      const factor = wheelFactor(event.deltaY);
      if (factor === undefined) {
        return;
      }
      event.preventDefault();
      zoomTo(state.scale * factor);
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
  viewport.addEventListener("dblclick", fitView);
  globalThis.addEventListener("resize", apply);
  apply();
}
