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

/** What the frame shows while it is held in an orientation (#16587). */
export interface PrototypeWebHeldView {
  /** The orientation of the layout shown, which picks the view. */
  readonly orientation: "portrait" | "landscape";
  /** How far the shown view turns so its layout sits in the held frame, in degrees. */
  readonly degrees: number;
}

/**
 * The layout shown in a frame held in `frame`. Unlocked, the layout follows the frame. While
 * rotation is locked the app keeps the frame's natural orientation, so a landscape frame shows the
 * portrait view turned a quarter counterclockwise, drawn sideways as a locked phone draws it.
 */
export function prototypeWebHeldView(
  frame: "portrait" | "landscape",
  natural: "portrait" | "landscape",
  locked: boolean,
): PrototypeWebHeldView {
  const orientation = locked ? natural : frame;
  if (orientation === frame) {
    return { orientation, degrees: 0 };
  }
  return { orientation, degrees: frame === "landscape" ? -90 : 90 };
}

/**
 * The re-layout when the lock changes while the frame stays put (#16587): the frame does not move,
 * so the outgoing layout fades out at its angle while the incoming one fades in at its own, with
 * the platform turn's timing.
 */
export function prototypeWebRelayout(
  turn: PrototypeWebRotation,
  fromDegrees: number,
  toDegrees: number,
): PrototypeWebRotation {
  const at = (degrees: number) => `translate(-50%, -50%) rotate(${degrees}deg)`;
  return {
    durationMs: turn.durationMs,
    easing: turn.easing,
    outgoing: [
      { transform: at(fromDegrees), opacity: 1 },
      { transform: at(fromDegrees), opacity: 0 },
    ],
    incoming: [
      { transform: at(toDegrees), opacity: 0 },
      { transform: at(toDegrees), opacity: 1 },
    ],
  };
}

/**
 * The status bar clock's text for a moment (#16585): local hours and minutes in the stills' fixed
 * `9:41` form, so a page whose browser clock is frozen at 9:41 draws the same bytes as the still.
 */
export function prototypeWebClockText(now: Date): string {
  const hours = now.getHours() % 12 || 12;
  return `${hours}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** Milliseconds from `nowMs` to the next minute boundary, when the clock's text next changes. */
export function prototypeWebClockDelay(nowMs: number): number {
  return 60_000 - (((nowMs % 60_000) + 60_000) % 60_000);
}

/** The time source and timer the status bar clock runs on: the browser's in the page, a fake in tests. */
export interface PrototypeWebClock {
  now(): number;
  schedule(run: () => void, ms: number): void;
}

/** The page's clock: the browser's own time and timers, since the page has no Timer seam to import. */
export function prototypeWebBrowserClock(): PrototypeWebClock {
  return {
    now: () => Date.now(),
    schedule: (run, ms) => void globalThis.setTimeout(run, ms),
  };
}

/**
 * Keeps every status bar clock (`[data-status="clock"]`) under `root` on the clock's local time:
 * writes the text now and again at each minute boundary. Nothing is scheduled without a clock.
 */
export function prototypeWebStartClock(
  root: { querySelectorAll(selector: string): Iterable<{ textContent: string | null }> },
  clock: PrototypeWebClock,
  format: {
    readonly clockText: typeof prototypeWebClockText;
    readonly clockDelay: typeof prototypeWebClockDelay;
  },
): void {
  const marks = Array.from(root.querySelectorAll('[data-status="clock"]'));
  if (marks.length === 0) {
    return;
  }
  const tick = () => {
    const now = clock.now();
    const text = format.clockText(new Date(now));
    marks.forEach((mark) => {
      mark.textContent = text;
    });
    clock.schedule(tick, format.clockDelay(now));
  };
  tick();
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
  /** The view's angle before and after the turn; they differ when a locked frame turns (#16587). */
  readonly degrees?: readonly [number, number];
}

/**
 * Starts one turn: the outgoing view stays visible and turns away, the shown view turns in, and
 * the stage's fitted scale follows. When the view stays (rotation locked, #16587) it turns between
 * its two angles, drawn sideways in a landscape frame. Nothing animates when neither the view nor
 * its angle changed, or the viewer prefers reduced motion. Returns the turn's animations, so a
 * later turn can finish them.
 */
export function prototypeWebAnimateTurn(
  turn: PrototypeWebRotation,
  targets: PrototypeWebTurnTargets,
): Animation[] {
  const { from, shown, stage, stageFrom, current, degrees = [0, 0] } = targets;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const still = from === shown && degrees[0] === degrees[1];
  if (!from || !shown || still || reduced || !shown.animate) {
    return [];
  }
  const timing = { duration: turn.durationMs, easing: turn.easing };
  const stageTurn = () =>
    stage.animate([{ transform: stageFrom }, { transform: stage.style.transform }], timing);
  if (from === shown) {
    const at = (angle: number) => `translate(-50%, -50%) rotate(${angle}deg)`;
    return [
      shown.animate(
        degrees.map((angle) => ({ transform: at(angle) })),
        timing,
      ),
      stageTurn(),
    ];
  }
  from.hidden = false;
  const outgoing = from.animate(turn.outgoing, timing);
  outgoing.onfinish = () => {
    from.hidden = from !== current();
  };
  return [outgoing, shown.animate(turn.incoming, timing), stageTurn()];
}

/** What the viewport's gestures move: the stage's zoom and pan, and its fitted scale. */
export interface PrototypeWebGestureTargets {
  readonly wheelFactor: typeof prototypeWebWheelFactor;
  readonly zoomBy: (factor: number) => void;
  readonly offset: () => { readonly x: number; readonly y: number };
  readonly panTo: (x: number, y: number) => void;
  readonly fit: () => void;
}

/**
 * The viewport's gestures: a vertical wheel zooms (a horizontal-only gesture passes through), a
 * drag pans and a double-click fits the shown view again.
 */
export function prototypeWebViewportGestures(
  viewport: HTMLElement,
  targets: PrototypeWebGestureTargets,
): void {
  viewport.addEventListener(
    "wheel",
    (event) => {
      const factor = targets.wheelFactor(event.deltaY);
      if (factor === undefined) {
        return;
      }
      event.preventDefault();
      targets.zoomBy(factor);
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | undefined;
  viewport.addEventListener("pointerdown", (event) => {
    const { x, y } = targets.offset();
    drag = { x: event.clientX - x, y: event.clientY - y };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (drag) {
      targets.panTo(event.clientX - drag.x, event.clientY - drag.y);
    }
  });
  viewport.addEventListener("pointerup", () => {
    drag = undefined;
  });
  viewport.addEventListener("dblclick", targets.fit);
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
  readonly heldView: typeof prototypeWebHeldView;
  readonly relayout: typeof prototypeWebRelayout;
  readonly viewportGestures: typeof prototypeWebViewportGestures;
  readonly clockText: typeof prototypeWebClockText;
  readonly clockDelay: typeof prototypeWebClockDelay;
  readonly startClock: typeof prototypeWebStartClock;
  readonly browserClock: typeof prototypeWebBrowserClock;
}

export function prototypeWebPageRuntime(rules: PrototypeWebRuntimeRules): void {
  const { zoomScale, fitScale: fitted, wheelFactor, screenView, viewMatches } = rules;
  const { rotation, animateTurn, heldView, relayout } = rules;
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
  const postureSelect = pick("layout-posture") as HTMLSelectElement | null;
  const revisionList = pick("revisions");
  const zoomLabel = pick("zoom-level");
  const bodyData = (name: string) => doc.body.dataset[name] ?? "";
  const state = {
    variant: bodyData("variant"),
    revision: bodyData("revision"),
    // The frame's first orientation: landscape for a TV or car, which never leaves it.
    orientation: bodyData("orientation") as "portrait" | "landscape",
    // The way the frame is held; the layout differs from it only while rotation is locked.
    frame: bodyData("orientation") as "portrait" | "landscape",
    // The shown view's angle as drawn, kept so a lock change starts from it, not from the new lock.
    degrees: 0,
    posture: bodyData("posture"),
    // The first apply sets the shown view's screen.
    screen: "",
    scale: 1,
    x: 0,
    y: 0,
    fit: true,
  };
  // The frame's natural orientation, which a locked app keeps (#16587).
  const natural = state.frame;
  // `data-rotation-lock="on"` on `body` locks rotation; the quick settings tile flips it (#16547).
  const held = () => heldView(state.frame, natural, bodyData("rotationLock") === "on");
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
    // Each orientation and posture can show a different stack, so it lists its own screens.
    const key = `${state.variant} ${state.revision} ${state.orientation} ${state.posture}`;
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
    const [width, height] = [frame.offsetWidth, frame.offsetHeight];
    // A view drawn sideways fills the viewport turned, so its sides swap.
    const box = held().degrees === 0 ? { width, height } : { width: height, height: width };
    return fitted({ width: viewport.clientWidth, height: viewport.clientHeight }, box);
  };
  const apply = () => {
    const shown = current();
    syncScreens(shown);
    const degrees = (state.degrees = held().degrees);
    views.forEach((view) => {
      view.hidden = view !== shown;
      view.style.transform =
        view === shown && degrees !== 0 ? `translate(-50%, -50%) rotate(${degrees}deg)` : "";
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
  // Re-lays out for the frame's hold and the lock, then animates from the view shown before.
  const relayOut = (frameTurns: boolean) => {
    turning.forEach((animation) => animation.finish());
    const [from, stageFrom, before] = [current(), stage.style.transform, state.degrees];
    if (frameTurns) {
      state.frame = state.frame === "portrait" ? "landscape" : "portrait";
    }
    const next = held();
    state.orientation = next.orientation;
    fitView();
    const turn = rotation(doc.body.dataset.platform ?? "", state.frame);
    const step = frameTurns ? turn : relayout(turn, before, next.degrees);
    const degrees = [before, next.degrees] as const;
    turning = animateTurn(step, { from, shown: current(), stage, stageFrom, current, degrees });
  };
  pick("rotate")?.addEventListener("click", () => relayOut(true));
  new MutationObserver(() => relayOut(false)).observe(doc.body, {
    attributes: true,
    attributeFilter: ["data-rotation-lock"],
  });
  pick("zoom-in")?.addEventListener("click", () => zoomTo(state.scale * 1.25));
  pick("zoom-out")?.addEventListener("click", () => zoomTo(state.scale / 1.25));
  pick("zoom-fit")?.addEventListener("click", fitView);
  variantSelect?.addEventListener("change", () => {
    state.variant = variantSelect.value;
    const option = variantSelect.selectedOptions[0];
    state.revision = option?.dataset.latest ?? state.revision;
    fitView();
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
  rules.viewportGestures(viewport, {
    wheelFactor,
    zoomBy: (factor) => zoomTo(state.scale * factor),
    offset: () => ({ x: state.x, y: state.y }),
    panTo: (x, y) => {
      state.fit = false;
      state.x = x;
      state.y = y;
      apply();
    },
    fit: fitView,
  });
  globalThis.addEventListener("resize", apply);
  // Every view's status bar clock follows the browser clock (#16585).
  rules.startClock(doc, rules.browserClock(), rules);
  apply();
}
