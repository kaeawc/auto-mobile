// The prototype web page's script (#16528): the page runtime and its 3D view, drawing each view
// the host did not inline from the page's spec JSON with the host's own view renderer. `build.ts`
// writes its minified build to src/features/prototype/web/prototypeWebPageBundle.generated.ts,
// which the server inlines and pins by hash.
import { bootPrototypeWebPage } from "../../../src/features/prototype/web/embed/prototypeWebPageBoot";
import {
  PROTOTYPE_WEB_FLAT_ORBIT,
  PROTOTYPE_WEB_START_ORBIT,
  prototypeWeb3dBodyHinge,
  prototypeWeb3dDragOrbit,
  prototypeWeb3dKeyOrbit,
  prototypeWeb3dLayoutReflow,
  prototypeWeb3dRuntime,
  prototypeWeb3dUnwrap,
  prototypeWeb3dWrap,
  prototypeWebHingeLine,
  prototypeWebLeaves,
  prototypeWebOrbit,
  prototypeWebOrbitKey,
  prototypeWebPose,
  prototypeWebPostureAt,
  prototypeWebReflowPosture,
} from "../../../src/features/prototype/web/webDevice3d";
import { PROTOTYPE_WEB_PAGE_DATA_SELECTOR } from "../../../src/features/prototype/web/webPageData";
import {
  prototypeWebAnimateTurn,
  prototypeWebBrowserClock,
  prototypeWebClockDelay,
  prototypeWebClockText,
  prototypeWebFitScale,
  prototypeWebHeldView,
  prototypeWebPageRuntime,
  prototypeWebRelayout,
  prototypeWebRotation,
  prototypeWebScreenView,
  prototypeWebStartClock,
  prototypeWebViewMatches,
  prototypeWebViewportGestures,
  prototypeWebWheelFactor,
  prototypeWebZoomScale,
} from "../../../src/features/prototype/web/webPageRuntime";

const ensureViews = bootPrototypeWebPage({
  dataText: () => document.querySelector(PROTOTYPE_WEB_PAGE_DATA_SELECTOR)?.textContent ?? null,
  views: () => Array.from(document.querySelectorAll<HTMLElement>("[data-view]")),
  // Beside the views already drawn: the 3D view moves them into its orbit box.
  insert: (html) =>
    (
      document.querySelector("[data-view]")?.parentElement ?? document.querySelector("[data-stage]")
    )?.insertAdjacentHTML("beforeend", html),
});

prototypeWebPageRuntime({
  zoomScale: prototypeWebZoomScale,
  fitScale: prototypeWebFitScale,
  wheelFactor: prototypeWebWheelFactor,
  screenView: prototypeWebScreenView,
  viewMatches: prototypeWebViewMatches,
  rotation: prototypeWebRotation,
  animateTurn: prototypeWebAnimateTurn,
  clockText: prototypeWebClockText,
  clockDelay: prototypeWebClockDelay,
  startClock: prototypeWebStartClock,
  browserClock: prototypeWebBrowserClock,
  heldView: prototypeWebHeldView,
  relayout: prototypeWebRelayout,
  viewportGestures: prototypeWebViewportGestures,
  ...(ensureViews ? { ensureViews } : {}),
});
// The 3D view runs after the 2D runtime, so its pan handler is already bound (#16458).
prototypeWeb3dRuntime({
  pose: prototypeWebPose,
  orbit: prototypeWebOrbit,
  hingeLine: prototypeWebHingeLine,
  postureAt: prototypeWebPostureAt,
  reflowPosture: prototypeWebReflowPosture,
  layoutReflow: prototypeWeb3dLayoutReflow,
  wrap: prototypeWeb3dWrap,
  unwrap: prototypeWeb3dUnwrap,
  bodyHinge: prototypeWeb3dBodyHinge,
  orbitKey: prototypeWebOrbitKey,
  dragOrbit: prototypeWeb3dDragOrbit,
  keyOrbit: prototypeWeb3dKeyOrbit,
  leaves: prototypeWebLeaves,
  flat: PROTOTYPE_WEB_FLAT_ORBIT,
  start: PROTOTYPE_WEB_START_ORBIT,
});
