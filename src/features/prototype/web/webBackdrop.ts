import { resolvePrototypeColor, type Rgba } from "../prototypeContrast";
import { record } from "../prototypeTemplate";
import { roleColor } from "./webSheet";
import { px, rgbaCss, type WebStyleContext } from "./webStyle";

/**
 * `window.backdrop` (#15126) in the still (#16536): the window blurs what is behind it, under the
 * backdrop's tint, as both devices draw it. A still has no app behind its window, so the screen
 * paints a neutral wallpaper there (WEB_BACKDROP_WALLPAPER) for the blur to show.
 */

type Css = Record<string, string>;

/** Each material's blur radius, in dp, when `blur` is absent: Android's radii, iOS's nearest. */
const MATERIAL_RADII: Readonly<Record<string, number>> = {
  ultraThin: 8,
  thin: 16,
  regular: 24,
  thick: 40,
};

/** Tonal fill alpha where the device draws the fallback: `tint`, else `surfaceContainer`. */
const FALLBACK_ALPHA = 0.85;
/** A tint's alpha over a real blur. */
const BLUR_TINT_ALPHA = 0.35;

/** What the still draws for a backdrop: a blur at `radius` dp, or the tonal fallback. */
export interface WebBackdropPlan {
  readonly mode: "blur" | "fallback";
  readonly radius: number;
  readonly tint?: string;
}

/** The material whose radius is nearest `blur`, as iOS picks a fixed SwiftUI Material. */
function nearestMaterialRadius(blur: number): number {
  return Object.values(MATERIAL_RADII).reduce((best, radius) =>
    Math.abs(radius - blur) < Math.abs(best - blur) ? radius : best,
  );
}

/**
 * The plan a current device draws: Android blurs (API 31+ with cross-window blur on) except for
 * `glass`, which is iOS-only, so it draws the fallback there; iOS 26 blurs every material, `glass`
 * included, at the nearest material's radius to an authored `blur`.
 */
export function webBackdropPlan(
  spec: unknown,
  platform: "android" | "ios",
): WebBackdropPlan | undefined {
  const backdrop = record(record(record(spec)?.window)?.backdrop);
  if (!backdrop || typeof backdrop.material !== "string") {
    return undefined;
  }
  const tint = typeof backdrop.tint === "string" ? { tint: backdrop.tint } : {};
  const own = MATERIAL_RADII[backdrop.material] ?? MATERIAL_RADII.regular!;
  const blur = typeof backdrop.blur === "number" ? backdrop.blur : undefined;
  if (platform === "ios") {
    return {
      mode: "blur",
      radius: blur === undefined ? own : nearestMaterialRadius(blur),
      ...tint,
    };
  }
  if (backdrop.material === "glass") {
    return { mode: "fallback", radius: 0, ...tint };
  }
  return { mode: "blur", radius: blur ?? own, ...tint };
}

/**
 * A blur radius as a CSS `blur()` standard deviation: Skia turns a blur radius into a sigma of
 * `0.57735 r + 0.5`, which Android's RenderEffect and window blur both use.
 */
const blurSigma = (radius: number) => (radius <= 0 ? 0 : 0.57735 * radius + 0.5);

/**
 * The window's backdrop: what is behind it blurred, under the tint at 0.35 (nothing untinted), or
 * the tonal fill at 0.85 where the device falls back.
 */
export function webBackdropCss(plan: WebBackdropPlan, style: WebStyleContext): Css {
  const tinted = (alpha: number, fallbackRole?: string): Css => {
    const color: Rgba | undefined =
      plan.tint === undefined
        ? fallbackRole === undefined
          ? undefined
          : roleColor(fallbackRole, style)
        : resolvePrototypeColor(plan.tint, style.mode, style.palette);
    return color ? { "background-color": rgbaCss({ ...color, a: color.a * alpha }) } : {};
  };
  if (plan.mode === "fallback") {
    return tinted(FALLBACK_ALPHA, "surfaceContainer");
  }
  const sigma = blurSigma(plan.radius);
  return {
    ...(sigma > 0 ? { "backdrop-filter": `blur(${px(sigma)})` } : {}),
    ...tinted(BLUR_TINT_ALPHA),
  };
}

/**
 * The neutral wallpaper a still paints behind a window with a backdrop, standing in for the app
 * the device would blur: soft shapes on a grey gradient, the same in every mode, so the blur reads.
 */
export const WEB_BACKDROP_WALLPAPER =
  "radial-gradient(circle at 22% 18%, #8f9fb3 0 16%, transparent 16.5%)," +
  "radial-gradient(circle at 78% 46%, #c4a98f 0 20%, transparent 20.5%)," +
  "radial-gradient(circle at 30% 80%, #9fb49a 0 18%, transparent 18.5%)," +
  "linear-gradient(160deg, #e4e2df, #a9b1bc)";
