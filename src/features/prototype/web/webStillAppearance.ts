import {
  parsePrototypeHex,
  prototypeLuminance,
  type PrototypeColorMode,
  type Rgba,
} from "../prototypeContrast";
import { record } from "../prototypeTemplate";
import { pagerPage } from "./webCollections";
import { bound, childEntries, preparedNode, type WebRenderScope } from "./webRender";

type PreparedWebNode = NonNullable<ReturnType<typeof preparedNode>>;

/** Below this luminance a screen colour reads as dark, as on Android (`DARK_LUMINANCE_CEILING`). */
const DARK_LUMINANCE_CEILING = 0.179;
/** A background at least this opaque is the screen colour the author painted. */
const OPAQUE_BACKGROUND_ALPHA = 0.99;

/** Which step of the documented mode order decided the still's mode. */
export type WebStillModeSource = "explicit" | "roleLuminance" | "authoredBackground" | "system";

export interface WebStillAppearance {
  readonly mode: PrototypeColorMode;
  readonly source: WebStillModeSource;
  /** The authored screen colour to paint over the surface roles, when its polarity is the mode's. */
  readonly surface?: Rgba;
}

function polarity(color: Rgba): PrototypeColorMode {
  return prototypeLuminance(color) < DARK_LUMINANCE_CEILING ? "dark" : "light";
}

/** A single opaque hex background; a role or a `{light, dark}` pair depends on the mode. */
function opaqueAuthoredBackground(value: unknown): Rgba | undefined {
  const color = typeof value === "string" ? parsePrototypeHex(value) : undefined;
  return color && color.a >= OPAQUE_BACKGROUND_ALPHA ? color : undefined;
}

/** The flat `theme.colors.background` override, else `surface`; per-mode maps never take part. */
function roleSurface(theme: Record<string, unknown> | undefined): Rgba | undefined {
  const colors = record(theme?.colors);
  const value = colors?.background ?? colors?.surface;
  return typeof value === "string" ? parsePrototypeHex(value) : undefined;
}

/**
 * The still's mode, in the order both devices resolve it: an explicit `theme.mode`; with no mode,
 * the luminance of the flat background/surface role override, then of the first opaque authored
 * background; last `system`, the caller's mode. `mode: "system"` goes straight to `system`.
 */
export function resolveWebStillAppearance(
  spec: unknown,
  authored: Rgba | undefined,
  system: PrototypeColorMode,
): WebStillAppearance {
  const theme = record(record(spec)?.theme);
  const decided = decideMode(theme, authored, system);
  // Android paints the authored colour only over a scheme of its own polarity.
  return authored && polarity(authored) === decided.mode
    ? { ...decided, surface: authored }
    : decided;
}

function decideMode(
  theme: Record<string, unknown> | undefined,
  authored: Rgba | undefined,
  system: PrototypeColorMode,
): WebStillAppearance {
  const mode = theme?.mode;
  if (mode === "light" || mode === "dark") {
    return { mode, source: "explicit" };
  }
  if (mode === "system") {
    return { mode: system, source: "system" };
  }
  const role = roleSurface(theme);
  if (role) {
    return { mode: polarity(role), source: "roleLuminance" };
  }
  if (authored) {
    return { mode: polarity(authored), source: "authoredBackground" };
  }
  return { mode: system, source: "system" };
}

/**
 * The first opaque hex background on the tree's leading chain: the root, then its first visible
 * child (a pager's current page), and so on, as both devices find the screen colour the author
 * painted. Hidden nodes paint nothing and are skipped; a role or `{light, dark}` background
 * depends on the mode, so the search goes on past it.
 */
export function webAuthoredBackground(
  node: unknown,
  scope: WebRenderScope,
  path: string,
): Rgba | undefined {
  return preparedBackground(preparedNode(node, scope, path), path);
}

/** The walk over an already prepared node, so each node on the chain is prepared once. */
function preparedBackground(prepared: PreparedWebNode | undefined, path: string): Rgba | undefined {
  if (!prepared) {
    return undefined;
  }
  const { styled, scope: local } = prepared;
  const own = opaqueAuthoredBackground(record(styled.style)?.background);
  if (own) {
    return own;
  }
  if (styled.type === "pager") {
    const pages = Array.isArray(styled.children) ? styled.children : [];
    const page = pagerPage(styled, local, { bound });
    const pagePath = `${path}.children[${page}]`;
    return preparedBackground(preparedNode(pages[page], local, pagePath), pagePath);
  }
  // A repeat's template counts only through the rows it draws, bound to each row.
  for (const entry of childEntries(styled, local, path)) {
    const child = preparedNode(entry.node, entry.scope, entry.path);
    if (child) {
      return preparedBackground(child, entry.path);
    }
  }
  return undefined;
}
