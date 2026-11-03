/**
 * THROWAWAY research prototype for #16349. Not for merge.
 *
 * A second page script that adds a CSS-3D view to the existing static prototype page. Like
 * `prototypeWebPageRuntime` it is inlined from `toString()`, so it is self-contained and gets its
 * pure rules as arguments.
 *
 * The shown frame element is never moved or re-rendered: it stays in its view as the fixed leaf
 * (clipped to its half). The moving leaf is a clone, because CSS cannot paint one DOM subtree in
 * two places. Back plates are plain divs, so a folded device shows its outside, not a mirror.
 */
import type { devicePose as DevicePoseFn, postureAtHinge as PostureAtHingeFn } from "./devicePose";

export interface Device3dRules {
  readonly pose: typeof DevicePoseFn;
  readonly postureAt: typeof PostureAtHingeFn;
  readonly flat: { yaw: number; pitch: number };
  readonly start: { yaw: number; pitch: number };
  readonly hinges: Readonly<Record<string, number>>;
}

export function device3dRuntime(rules: Device3dRules): void {
  const doc = document;
  const viewport = doc.querySelector<HTMLElement>("[data-viewport]");
  const toolbar = doc.querySelector<HTMLElement>("[data-toolbar]");
  if (!viewport || !toolbar) {
    return;
  }
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const state = { on: false, orbit: rules.flat, hinge: 180 };
  const axis = (doc.body.dataset.hingeAxis === "horizontal" ? "horizontal" : "vertical") as
    | "vertical"
    | "horizontal";
  // Controls: a toggle, a posture select, a hinge slider and a live status line.
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.dataset.control = "3d";
  toggle.textContent = "3D";
  toggle.setAttribute("aria-pressed", "false");
  const postureSelect = doc.createElement("select");
  postureSelect.dataset.control = "posture";
  postureSelect.setAttribute("aria-label", "Posture");
  postureSelect.replaceChildren(
    ...Object.keys(rules.hinges).map((name) => new Option(name, name, name === "opened", name === "opened")),
  );
  const hingeLabel = doc.createElement("label");
  hingeLabel.textContent = "Hinge ";
  const hinge = doc.createElement("input");
  hinge.type = "range";
  hinge.min = "0";
  hinge.max = "360";
  hinge.step = "5";
  hinge.value = "180";
  hinge.dataset.control = "hinge";
  hingeLabel.append(hinge);
  const status = doc.createElement("span");
  status.dataset.control = "status3d";
  status.setAttribute("role", "status");
  toolbar.append(toggle, postureSelect, hingeLabel, status);
  // The toolbar may wrap; let the page re-fit the frame to the smaller viewport.
  globalThis.dispatchEvent(new Event("resize"));

  let parts: { view: HTMLElement; extras: HTMLElement[]; leaf: HTMLElement } | undefined;
  const vertical = axis === "vertical";
  const flip = vertical ? "rotateY(180deg)" : "rotateX(180deg)";
  const box = (css: Partial<CSSStyleDeclaration>, data: string) => {
    const div = doc.createElement("div");
    div.dataset[data] = "";
    div.setAttribute("aria-hidden", "true");
    Object.assign(div.style, { position: "absolute", ...css });
    return div;
  };
  const unwrap = () => {
    if (!parts) {
      return;
    }
    parts.extras.forEach((extra) => extra.remove());
    const frame = parts.view.firstElementChild as HTMLElement | null;
    frame?.style.removeProperty("clip-path");
    parts.view.style.removeProperty("transform");
    parts = undefined;
  };
  // Chromium does not draw a clip-path element that has its own 3D transform inside a
  // preserve-3d context, so only the untransformed fixed leaf is clipped; the moving leaf is an
  // overflow-hidden half box holding a clone of the whole frame, offset by half.
  const wrap = () => {
    const view = Array.from(doc.querySelectorAll<HTMLElement>("[data-view]")).find((v) => !v.hidden);
    const frame = view?.firstElementChild as HTMLElement | null;
    if (!view || !frame || parts?.view === view) {
      return;
    }
    unwrap();
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    const r = getComputedStyle(frame).borderTopLeftRadius;
    const hw = vertical ? w / 2 : w;
    const hh = vertical ? h : h / 2;
    const size = { width: `${hw}px`, height: `${hh}px` };
    frame.style.clipPath = vertical ? "inset(0 50% 0 0)" : "inset(0 0 50% 0)";
    const fixedBack = box(
      {
        left: "0",
        top: "0",
        ...size,
        transform: flip,
        borderRadius: vertical ? `0 ${r} ${r} 0` : `0 0 ${r} ${r}`,
      },
      "back",
    );
    const leaf = box(
      {
        left: vertical ? `${hw}px` : "0",
        top: vertical ? "0" : `${hh}px`,
        ...size,
        transformOrigin: vertical ? "0 50%" : "50% 0",
        transformStyle: "preserve-3d",
      },
      "leaf",
    );
    const face = box({ left: "0", top: "0", ...size, overflow: "hidden" }, "face");
    const clone = frame.cloneNode(true) as HTMLElement;
    clone.inert = true;
    Object.assign(clone.style, {
      position: "absolute",
      left: vertical ? `${-hw}px` : "0",
      top: vertical ? "0" : `${-hh}px`,
      clipPath: "none",
    });
    face.append(clone);
    const movingBack = box(
      {
        left: "0",
        top: "0",
        ...size,
        transform: flip,
        borderRadius: vertical ? `${r} 0 0 ${r}` : `${r} ${r} 0 0`,
      },
      "back",
    );
    leaf.append(face, movingBack);
    view.append(fixedBack, leaf);
    parts = { view, extras: [fixedBack, leaf], leaf };
  };
  const apply = () => {
    if (state.on) {
      wrap();
    }
    if (!parts) {
      return;
    }
    const pose = rules.pose(state.orbit, state.hinge, axis);
    parts.view.style.transform = `translate(-50%,-50%) ${pose.device}`;
    parts.leaf.style.transform = pose.leaf;
    const layout = rules.postureAt(state.hinge);
    doc.body.dataset.panelLayout = layout;
    status.textContent = state.on ? `${state.hinge}° · layout ${layout}` : "";
  };
  const setOn = (on: boolean) => {
    state.on = on;
    toggle.setAttribute("aria-pressed", String(on));
    doc.body.toggleAttribute("data-3d", on);
    if (on) {
      state.orbit = rules.flat;
      apply();
      // Two frames: the flat pose paints first, then the transition runs to the 3D pose.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          state.orbit = rules.start;
          apply();
        }),
      );
      return;
    }
    state.orbit = rules.flat;
    state.hinge = 180;
    hinge.value = "180";
    postureSelect.value = "opened";
    apply();
    const done = () => {
      if (!state.on) {
        unwrap();
      }
    };
    if (reduced) {
      done();
    } else {
      parts?.view.addEventListener("transitionend", done, { once: true });
    }
  };
  toggle.addEventListener("click", () => setOn(!state.on));
  postureSelect.addEventListener("change", () => {
    state.hinge = rules.hinges[postureSelect.value] ?? 180;
    hinge.value = String(state.hinge);
    if (!state.on) {
      setOn(true);
    }
    apply();
  });
  hinge.addEventListener("input", () => {
    state.hinge = Number(hinge.value);
    apply();
  });
  viewport.tabIndex = 0;
  viewport.addEventListener("keydown", (event) => {
    if (!state.on) {
      return;
    }
    const step = event.shiftKey ? 15 : 5;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      state.orbit = { yaw: state.orbit.yaw + move[0], pitch: state.orbit.pitch + move[1] };
      apply();
    }
  });
  // Shift-drag orbits in 3D; a plain drag still pans through the page's own handler.
  let drag: { x: number; y: number } | undefined;
  viewport.addEventListener(
    "pointerdown",
    (event) => {
      if (state.on && event.shiftKey) {
        event.stopImmediatePropagation();
        drag = { x: event.clientX, y: event.clientY };
        viewport.setPointerCapture(event.pointerId);
      }
    },
    { capture: true },
  );
  viewport.addEventListener(
    "pointermove",
    (event) => {
      if (drag) {
        event.stopImmediatePropagation();
        state.orbit = {
          yaw: state.orbit.yaw + (event.clientX - drag.x) * 0.4,
          pitch: state.orbit.pitch - (event.clientY - drag.y) * 0.4,
        };
        drag = { x: event.clientX, y: event.clientY };
        apply();
      }
    },
    { capture: true },
  );
  viewport.addEventListener("pointerup", () => {
    drag = undefined;
  });
  // The page's own controls switch views; re-wrap the newly shown one.
  new MutationObserver(() => {
    if (state.on && parts && parts.view.hidden) {
      unwrap();
      apply();
    }
  }).observe(doc.querySelector("[data-stage]") ?? doc.body, {
    attributes: true,
    attributeFilter: ["hidden"],
    subtree: true,
  });
}

/** CSS the 3D view adds to the page. */
export const DEVICE_3D_CSS = [
  "[data-viewport]{perspective:2400px}",
  "[data-stage],[data-view]{transform-style:preserve-3d}",
  "[data-view]>*,[data-face],[data-back]{backface-visibility:hidden}",
  "[data-back]{background:linear-gradient(135deg,#3a3a3e,#1c1c1f)}",
  "[data-view]{transition:transform .45s cubic-bezier(.2,.7,.2,1)}",
  "[data-leaf]{transition:transform .45s cubic-bezier(.2,.7,.2,1)}",
  "@media (prefers-reduced-motion:reduce){[data-view],[data-leaf]{transition:none}}",
].join("");
