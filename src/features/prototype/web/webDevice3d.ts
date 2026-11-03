import type { DeviceFrame } from "./deviceFrames";
import { el, type WebElement } from "./webNodes";

/**
 * The prototype web page's opt-in 3D device view (#16458, prototype-web-3d.md). CSS 3D transforms
 * only: the shown view stays live DOM, and only compositor transforms change. The runtime is
 * inlined from `toString()` like the page's 2D runtime, so it is self-contained and gets its pure
 * rules as arguments.
 */

/** Rotation of the device about its vertical (`yaw`) and horizontal (`pitch`) axes, in degrees. */
export interface PrototypeWebOrbit {
  readonly yaw: number;
  readonly pitch: number;
}

/** The flat 2D pose; leaving 3D transitions back to it. */
export const PROTOTYPE_WEB_FLAT_ORBIT: PrototypeWebOrbit = { yaw: 0, pitch: 0 };
/** The three-quarter pose entering 3D transitions to. */
export const PROTOTYPE_WEB_START_ORBIT: PrototypeWebOrbit = { yaw: 30, pitch: 14 };

/** Yaw wraps into [-180, 180); pitch stops at ±80 so the device never turns over the top. */
export function prototypeWebOrbit(orbit: PrototypeWebOrbit): PrototypeWebOrbit {
  return {
    yaw: ((((orbit.yaw + 180) % 360) + 360) % 360) - 180,
    pitch: Math.max(-80, Math.min(80, orbit.pitch)),
  };
}

/** Where the hinge line lies on the shown frame: its axis and its offset as a share of the frame. */
export interface PrototypeWebHingeLine {
  readonly axis: "vertical" | "horizontal";
  readonly at: number;
}

/**
 * The hinge line in the shown orientation. A frame's hinge is given in portrait; landscape turns
 * the frame a quarter counterclockwise, so a vertical hinge at `at` becomes a horizontal one at
 * `1 - at` and a horizontal hinge at `at` becomes a vertical one at `at`.
 */
export function prototypeWebHingeLine(
  hinge: PrototypeWebHingeLine,
  orientation: string,
): PrototypeWebHingeLine {
  if (orientation !== "landscape") {
    return hinge;
  }
  return hinge.axis === "vertical"
    ? { axis: "horizontal", at: 1 - hinge.at }
    : { axis: "vertical", at: hinge.at };
}

/** The CSS transforms of one pose. */
export interface PrototypeWebPose {
  /** The shown view's transform, after the view's own centring translate. */
  readonly device: string;
  /** The moving leaf's transform about the hinge line. */
  readonly leaf: string;
}

/**
 * The transforms for an orbit and a hinge angle (`setPosture` degrees: 180 flat, 0 shut, above 180
 * folded backwards). The fixed leaf is the start (left or top) side; the moving leaf turns by
 * `180 - hinge` about the hinge line. Self-contained, because the page inlines its `toString()`.
 */
export function prototypeWebPose(
  orbit: PrototypeWebOrbit,
  hingeDegrees: number,
  axis: "vertical" | "horizontal",
): PrototypeWebPose {
  const yaw = ((((orbit.yaw + 180) % 360) + 360) % 360) - 180;
  const pitch = Math.max(-80, Math.min(80, orbit.pitch));
  const turn = 180 - Math.max(0, Math.min(360, hingeDegrees));
  return {
    device: `rotateX(${-pitch}deg) rotateY(${yaw}deg)`,
    leaf: axis === "vertical" ? `rotateY(${-turn}deg)` : `rotateX(${turn}deg)`,
  };
}

/** One posture the frame supports and the hinge angle the web view draws it at. */
export interface PrototypeWebPostureAngle {
  readonly posture: string;
  readonly hingeDegrees: number;
}

/**
 * The posture whose layout the screen shows at a hinge angle: the frame's posture drawn nearest
 * to it, so the thresholds sit halfway between the frame's own `postures[].hingeDegrees` and stay
 * per device. A tie keeps the posture listed first; a frame without postures has none.
 */
export function prototypeWebPostureAt(
  degrees: number,
  postures: readonly PrototypeWebPostureAngle[],
): string | undefined {
  const angle = Math.max(0, Math.min(360, degrees));
  let best: PrototypeWebPostureAngle | undefined;
  for (const entry of postures) {
    if (!best || Math.abs(entry.hingeDegrees - angle) < Math.abs(best.hingeDegrees - angle)) {
      best = entry;
    }
  }
  return best?.posture;
}

/** What the page tells the 3D runtime about the frame's fold; undefined for a frame that does not fold. */
export interface PrototypeWebFold {
  /** The hinge line in portrait; `at` is the hinge's centre as a share of its panel. */
  readonly hinge: PrototypeWebHingeLine;
  readonly postures: readonly PrototypeWebPostureAngle[];
}

/** A frame folds in the web view when it has a hinge and at least one posture to draw. */
export function prototypeWebFold(frame: DeviceFrame): PrototypeWebFold | undefined {
  const { hinge } = frame;
  const panel = hinge && frame.panels.find((candidate) => candidate.role === hinge.panel);
  if (!hinge || !panel || frame.postures.length === 0) {
    return undefined;
  }
  const extent = hinge.axis === "vertical" ? panel.screen.widthDp : panel.screen.heightDp;
  const at = Math.round(((hinge.positionDp + hinge.widthDp / 2) / extent) * 10_000) / 10_000;
  return {
    hinge: { axis: hinge.axis, at },
    postures: frame.postures.map((entry) => ({
      posture: entry.posture,
      hingeDegrees: entry.hingeDegrees,
    })),
  };
}

/** The flat posture the hinge starts at and returns to when 3D is left. */
const FLAT_HINGE_DEGREES = 180;

/**
 * The 3D controls: a toggle, and for a frame that folds a posture select, a hinge range (0–360,
 * 180 flat) and a status line. They start hidden; the runtime shows them where CSS 3D works.
 */
export function prototypeWeb3dControls(fold: PrototypeWebFold | undefined): WebElement[] {
  const toggle = el(
    "button",
    {
      attrs: {
        type: "button",
        "data-control": "3d",
        "data-3d-control": "",
        "aria-pressed": "false",
        "aria-label": "3D view",
        hidden: "",
      },
    },
    ["3D"],
  );
  if (!fold) {
    return [toggle];
  }
  const flat = fold.postures.find((entry) => entry.hingeDegrees === FLAT_HINGE_DEGREES);
  return [
    toggle,
    el(
      "select",
      {
        attrs: {
          "data-control": "posture",
          "data-3d-control": "",
          "aria-label": "Posture",
          hidden: "",
        },
      },
      fold.postures.map((entry) =>
        el(
          "option",
          {
            attrs: {
              value: entry.posture,
              "data-hinge": String(entry.hingeDegrees),
              ...(entry === flat ? { selected: "" } : {}),
            },
          },
          [entry.posture],
        ),
      ),
    ),
    el("label", { attrs: { "data-3d-control": "", hidden: "" } }, [
      "Hinge ",
      el(
        "input",
        {
          attrs: {
            type: "range",
            min: "0",
            max: "360",
            step: "5",
            value: String(FLAT_HINGE_DEGREES),
            "data-control": "hinge",
          },
        },
        [],
      ),
    ]),
    el(
      "span",
      { attrs: { "data-control": "status3d", "data-3d-control": "", role: "status" } },
      [],
    ),
  ];
}

/** The body attributes that hand the frame's hinge to the runtime. */
export function prototypeWeb3dBodyAttributes(fold: PrototypeWebFold | undefined): string {
  return fold ? ` data-hinge-axis="${fold.hinge.axis}" data-hinge-at="${fold.hinge.at}"` : "";
}

/**
 * The CSS the 3D view adds. Every 3D rule is scoped to `[data-device3d]`, which the runtime sets
 * only while the view is wrapped, so the 2D page renders exactly as before. Where
 * `transform-style: preserve-3d` is unsupported the controls never show.
 */
export const PROTOTYPE_WEB_3D_CSS = [
  "@supports not (transform-style:preserve-3d){[data-3d-control]{display:none!important}}",
  "[data-device3d] [data-viewport]{perspective:2400px}",
  "[data-device3d] [data-stage],[data-wrapped]{transform-style:preserve-3d}",
  "[data-wrapped]>*,[data-face],[data-back]{backface-visibility:hidden}",
  "[data-back]{background:linear-gradient(135deg,#3a3a3e,#1c1c1f)}",
  "[data-wrapped],[data-leaf]{transition:transform .45s cubic-bezier(.2,.7,.2,1)}",
  "@media (prefers-reduced-motion:reduce){[data-wrapped],[data-leaf]{transition:none}}",
].join("");

/** One wrapped view: the elements 3D added and the attributes it changed, to restore exactly. */
export interface PrototypeWeb3dWrapped {
  readonly view: HTMLElement;
  readonly frame: HTMLElement;
  readonly viewStyle: string | null;
  readonly frameStyle: string | null;
  readonly extras: readonly HTMLElement[];
  /** The moving leaf; a frame that does not fold has none. */
  readonly leaf: HTMLElement | undefined;
  readonly axis: "vertical" | "horizontal";
}

/** Where the two leaves of a folding frame sit, in px of the frame box. `R` stands for the corner radius. */
export interface PrototypeWebLeaves {
  /** The back plates' turn, about the hinge's own axis. */
  readonly flip: string;
  /** The fixed leaf's clip on the frame itself, and its back plate's box and corners. */
  readonly clip: string;
  readonly fixed: Readonly<Record<string, string>>;
  readonly fixedCorners: string;
  /** The moving leaf's box, its turn origin, its corners, and where the clone sits inside it. */
  readonly moving: Readonly<Record<string, string>>;
  readonly origin: string;
  readonly movingCorners: string;
  readonly clone: Readonly<Record<string, string>>;
}

/**
 * Splits a `width` × `height` frame at the hinge line: the fixed leaf is the start (left or top)
 * side up to the line, the moving leaf the rest, turning about the line.
 */
export function prototypeWebLeaves(
  width: number,
  height: number,
  line: PrototypeWebHingeLine,
): PrototypeWebLeaves {
  const px = (value: number) => `${value}px`;
  if (line.axis === "vertical") {
    const split = width * line.at;
    return {
      flip: "rotateY(180deg)",
      clip: `inset(0 ${px(width - split)} 0 0)`,
      fixed: { width: px(split), height: px(height) },
      fixedCorners: "0 R R 0",
      moving: { left: px(split), width: px(width - split), height: px(height) },
      origin: "0 50%",
      movingCorners: "R 0 0 R",
      clone: { left: px(-split) },
    };
  }
  const split = height * line.at;
  return {
    flip: "rotateX(180deg)",
    clip: `inset(0 0 ${px(height - split)} 0)`,
    fixed: { width: px(width), height: px(split) },
    fixedCorners: "0 0 R R",
    moving: { top: px(split), width: px(width), height: px(height - split) },
    origin: "50% 0",
    movingCorners: "R R 0 0",
    clone: { top: px(-split) },
  };
}

/**
 * Wraps the shown view for 3D. The shown frame stays in place as the fixed leaf. CSS cannot paint
 * one subtree twice, so the moving leaf is an inert clone inside an overflow-hidden box: Chromium
 * does not draw a clip-path element that carries its own 3D transform, so only the untransformed
 * fixed leaf is clipped. Back plates hide behind each face, so a shut device shows its outside.
 * A frame that does not fold gets one back plate.
 */
export function prototypeWeb3dWrap(
  view: HTMLElement,
  line: PrototypeWebHingeLine | undefined,
  leaves: typeof prototypeWebLeaves,
): PrototypeWeb3dWrapped | undefined {
  const frame = view.firstElementChild as HTMLElement | null;
  if (!frame) {
    return undefined;
  }
  const box = (data: string, css: Readonly<Record<string, string>>) => {
    const div = document.createElement("div");
    div.setAttribute(`data-${data}`, "");
    div.setAttribute("aria-hidden", "true");
    Object.assign(div.style, { position: "absolute", left: "0", top: "0", ...css });
    return div;
  };
  const [width, height] = [frame.offsetWidth, frame.offsetHeight];
  const radius = getComputedStyle(frame).borderTopLeftRadius;
  const corners = (mask: string) => mask.replaceAll("R", radius);
  const saved = { viewStyle: view.getAttribute("style"), frameStyle: frame.getAttribute("style") };
  const size = { width: `${width}px`, height: `${height}px` };
  let extras: HTMLElement[] = [
    box("back", { ...size, transform: "rotateY(180deg)", borderRadius: radius }),
  ];
  let leaf: HTMLElement | undefined;
  if (line) {
    const at = leaves(width, height, line);
    frame.style.clipPath = at.clip;
    const clone = frame.cloneNode(true) as HTMLElement;
    clone.inert = true;
    clone.setAttribute("aria-hidden", "true");
    Object.assign(clone.style, { position: "absolute", left: "0", top: "0", clipPath: "none" });
    Object.assign(clone.style, at.clone);
    const face = box("face", { ...at.moving, left: "0", top: "0", overflow: "hidden" });
    face.append(clone);
    leaf = box("leaf", { ...at.moving, transformOrigin: at.origin, transformStyle: "preserve-3d" });
    const back = {
      left: "0",
      top: "0",
      transform: at.flip,
      borderRadius: corners(at.movingCorners),
    };
    leaf.append(face, box("back", { ...at.moving, ...back }));
    const fixedBack = { transform: at.flip, borderRadius: corners(at.fixedCorners) };
    extras = [box("back", { ...at.fixed, ...fixedBack }), leaf];
  }
  view.append(...extras);
  view.setAttribute("data-wrapped", "");
  return { view, frame, ...saved, extras, leaf, axis: line?.axis ?? "vertical" };
}

/** Removes what wrapping added and restores the view's and frame's own attributes byte for byte. */
export function prototypeWeb3dUnwrap(wrapped: PrototypeWeb3dWrapped): void {
  const restore = (element: HTMLElement, style: string | null) => {
    // Chromium writes CSSOM changes back to the attribute lazily; reading it first flushes that
    // write, so it cannot land after the removal and leave an empty `style=""` behind.
    element.getAttribute("style");
    if (style === null) {
      element.removeAttribute("style");
    } else {
      element.setAttribute("style", style);
    }
  };
  wrapped.extras.forEach((extra) => extra.remove());
  restore(wrapped.view, wrapped.viewStyle);
  restore(wrapped.frame, wrapped.frameStyle);
  wrapped.view.removeAttribute("data-wrapped");
}

/**
 * Shift-drag orbit: a Shift press on the viewport while 3D is on is taken in the capture phase, so
 * the 2D runtime's pan never sees it; a plain drag passes through and still pans.
 */
export function prototypeWeb3dDragOrbit(
  viewport: HTMLElement,
  isOn: () => boolean,
  orbitBy: (delta: PrototypeWebOrbit) => void,
): void {
  let drag: { x: number; y: number } | undefined;
  const capture = { capture: true };
  viewport.addEventListener(
    "pointerdown",
    (event) => {
      if (isOn() && event.shiftKey) {
        event.stopImmediatePropagation();
        drag = { x: event.clientX, y: event.clientY };
        viewport.setPointerCapture(event.pointerId);
      }
    },
    capture,
  );
  viewport.addEventListener(
    "pointermove",
    (event) => {
      if (drag) {
        event.stopImmediatePropagation();
        const delta = {
          yaw: (event.clientX - drag.x) * 0.4,
          pitch: (drag.y - event.clientY) * 0.4,
        };
        drag = { x: event.clientX, y: event.clientY };
        orbitBy(delta);
      }
    },
    capture,
  );
  viewport.addEventListener("pointerup", () => {
    drag = undefined;
  });
}

/** The pure rules and DOM helpers the 3D runtime is handed as arguments, so they are unit-tested and inlined with it. */
export interface PrototypeWeb3dRules {
  readonly pose: typeof prototypeWebPose;
  readonly orbit: typeof prototypeWebOrbit;
  readonly hingeLine: typeof prototypeWebHingeLine;
  readonly postureAt: typeof prototypeWebPostureAt;
  readonly wrap: typeof prototypeWeb3dWrap;
  readonly leaves: typeof prototypeWebLeaves;
  readonly unwrap: typeof prototypeWeb3dUnwrap;
  readonly bodyHinge: typeof prototypeWeb3dBodyHinge;
  readonly orbitKey: typeof prototypeWebOrbitKey;
  readonly dragOrbit: typeof prototypeWeb3dDragOrbit;
  readonly flat: PrototypeWebOrbit;
  readonly start: PrototypeWebOrbit;
}

/** The frame's hinge as the page's body attributes hand it over, if the frame folds. */
export function prototypeWeb3dBodyHinge(body: HTMLElement): PrototypeWebHingeLine | undefined {
  const at = Number(body.dataset.hingeAt);
  const axis = body.dataset.hingeAxis;
  if ((axis !== "vertical" && axis !== "horizontal") || !Number.isFinite(at)) {
    return undefined;
  }
  return { axis, at };
}

/** The orbit one arrow key applies, Shift for larger steps; any other key orbits nowhere. */
export function prototypeWebOrbitKey(key: string, large: boolean): PrototypeWebOrbit | undefined {
  const step = large ? 15 : 5;
  const moves: Record<string, PrototypeWebOrbit> = {
    ArrowLeft: { yaw: -step, pitch: 0 },
    ArrowRight: { yaw: step, pitch: 0 },
    ArrowUp: { yaw: 0, pitch: step },
    ArrowDown: { yaw: 0, pitch: -step },
  };
  return moves[key];
}

/**
 * The opt-in 3D view's script: a toggle, posture select, hinge range, arrow-key orbit on the
 * focused viewport and Shift-drag orbit. Entering 3D wraps the shown view at the flat pose and
 * transitions to a three-quarter pose; leaving transitions back and unwraps when it ends. Nothing
 * runs where CSS 3D is unsupported, so the page stays the 2D page there.
 */
export function prototypeWeb3dRuntime(rules: PrototypeWeb3dRules): void {
  const doc = document;
  const viewport = doc.querySelector<HTMLElement>("[data-viewport]");
  const stage = doc.querySelector<HTMLElement>("[data-stage]");
  const toggle = doc.querySelector<HTMLElement>('[data-control="3d"]');
  const supported = globalThis.CSS?.supports?.("transform-style", "preserve-3d") === true;
  if (!viewport || !stage || !toggle || !supported) {
    return;
  }
  const postureSelect = doc.querySelector<HTMLSelectElement>('[data-control="posture"]');
  const hingeInput = doc.querySelector<HTMLInputElement>('[data-control="hinge"]');
  const status = doc.querySelector<HTMLElement>('[data-control="status3d"]');
  const postures = Array.from(postureSelect?.options ?? []).map((option) => ({
    posture: option.value,
    hingeDegrees: Number(option.dataset.hinge),
  }));
  const hinge = rules.bodyHinge(doc.body);
  const state = { on: false, orbit: rules.flat, hinge: 180 };
  let wrapped: PrototypeWeb3dWrapped | undefined;
  doc.querySelectorAll<HTMLElement>("[data-3d-control]").forEach((control) => {
    control.hidden = false;
  });
  viewport.tabIndex = 0;
  // The toolbar may now wrap onto another line; let the 2D runtime refit the frame.
  globalThis.dispatchEvent(new Event("resize"));

  const unwrap = () => {
    if (wrapped) {
      rules.unwrap(wrapped);
      wrapped = undefined;
      doc.body.removeAttribute("data-device3d");
    }
  };
  const wrap = () => {
    const view = Array.from(doc.querySelectorAll<HTMLElement>("[data-view]")).find(
      (candidate) => !candidate.hidden,
    );
    if (!view || wrapped?.view === view) {
      return;
    }
    unwrap();
    wrapped = rules.wrap(
      view,
      hinge && rules.hingeLine(hinge, view.dataset.orientation ?? ""),
      rules.leaves,
    );
    doc.body.toggleAttribute("data-device3d", wrapped !== undefined);
  };
  const apply = () => {
    if (state.on) {
      wrap();
    }
    const layout = hinge && rules.postureAt(state.hinge, postures);
    if (status) {
      status.textContent = state.on && layout ? `Hinge ${state.hinge}°, ${layout} layout` : "";
    }
    if (wrapped) {
      const pose = rules.pose(state.orbit, state.hinge, wrapped.axis);
      wrapped.view.style.transform = `translate(-50%, -50%) ${pose.device}`;
      wrapped.leaf?.style.setProperty("transform", pose.leaf);
    }
  };
  const enter = () => {
    state.on = true;
    toggle.setAttribute("aria-pressed", "true");
    state.orbit = rules.flat;
    apply();
    // The flat pose paints first, so the view transitions from 2D into the 3D pose.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        state.orbit = state.on ? rules.start : state.orbit;
        apply();
      }),
    );
  };
  const leave = () => {
    state.on = false;
    toggle.setAttribute("aria-pressed", "false");
    state.orbit = rules.flat;
    state.hinge = 180;
    if (hingeInput) {
      hingeInput.value = "180";
    }
    const flat = postures.find((entry) => entry.hingeDegrees === 180);
    if (postureSelect && flat) {
      postureSelect.value = flat.posture;
    }
    apply();
    const leaving = wrapped?.view;
    const done = () => {
      if (!state.on && wrapped?.view === leaving) {
        unwrap();
      }
    };
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
      done();
      return;
    }
    // Reading the animations flushes style, so the transition back to flat is already running; a
    // view that was already flat has none and unwraps at once.
    const running = [leaving, wrapped?.leaf].flatMap((element) => element?.getAnimations() ?? []);
    void Promise.allSettled(running.map((animation) => animation.finished)).then(done);
  };
  const setHinge = (degrees: number) => {
    state.hinge = Math.max(0, Math.min(360, degrees));
    if (hingeInput) {
      hingeInput.value = String(state.hinge);
    }
    if (state.on) {
      apply();
    } else {
      enter();
    }
  };
  toggle.addEventListener("click", () => (state.on ? leave() : enter()));
  postureSelect?.addEventListener("change", () =>
    setHinge(Number(postureSelect.selectedOptions[0]?.dataset.hinge ?? 180)),
  );
  hingeInput?.addEventListener("input", () => setHinge(Number(hingeInput.value)));
  const orbitBy = (delta: PrototypeWebOrbit) => {
    state.orbit = rules.orbit({
      yaw: state.orbit.yaw + delta.yaw,
      pitch: state.orbit.pitch + delta.pitch,
    });
    apply();
  };
  viewport.addEventListener("keydown", (event) => {
    const move = rules.orbitKey(event.key, event.shiftKey);
    if (state.on && move) {
      event.preventDefault();
      orbitBy(move);
    }
  });
  // Shift-drag orbits in 3D; a plain drag still reaches the 2D runtime's pan.
  rules.dragOrbit(viewport, () => state.on, orbitBy);
  // The 2D controls switch views; the newly shown one is wrapped in place of the hidden one.
  new MutationObserver(() => {
    if (wrapped?.view.hidden) {
      unwrap();
      apply();
    }
  }).observe(stage, { attributes: true, attributeFilter: ["hidden"], subtree: true });
}
