import {
  parsePrototypeHex,
  prototypeLuminance,
  type PrototypeColorMode,
  type Rgba,
} from "../prototypeContrast";
import { record, type Raw } from "../prototypeTemplate";
import { pagerPage } from "./webCollections";
import {
  bound,
  childEntries,
  preparedNode,
  type WebChildEntry,
  type WebRenderScope,
} from "./webRender";
import { sheetOpen } from "./webSheet";
import { stackScreen } from "./webStack";

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
 * The first opaque hex background on the tree's leading chain: the root, then the child it draws
 * first, and so on, as both devices find the screen colour the author painted. A pager follows its
 * current page, a scroll its `child` and a stack the screen it draws. A node that draws nothing in
 * place is skipped: a hidden one, or a sheet whose `openWhen` does not hold. A role or
 * `{light, dark}` background depends on the mode, so the search goes on past it.
 */
export function webAuthoredBackground(
  node: unknown,
  scope: WebRenderScope,
  path: string,
): Rgba | undefined {
  // Only the outermost stack draws the still's chosen screen, as the stack renderer records it.
  return chainBackground(node, scope, path, scope.stacks?.length === 0);
}

function chainBackground(
  node: unknown,
  scope: WebRenderScope,
  path: string,
  outermostStack: boolean,
): Rgba | undefined {
  const prepared = drawnNode(node, scope, path);
  if (!prepared) {
    return undefined;
  }
  const { styled, scope: local } = prepared;
  const own = opaqueAuthoredBackground(record(styled.style)?.background);
  if (own) {
    return own;
  }
  const next = leadingChild(styled, local, path, outermostStack);
  const stillOutermost = outermostStack && styled.type !== "stack";
  return next ? chainBackground(next.node, next.scope, next.path, stillOutermost) : undefined;
}

/** The prepared node when it draws in place: not hidden and not a closed sheet. */
function drawnNode(
  node: unknown,
  scope: WebRenderScope,
  path: string,
): ReturnType<typeof preparedNode> {
  const prepared = preparedNode(node, scope, path);
  return prepared?.styled.type === "bottomSheet" && !sheetOpen(prepared.styled, prepared.scope)
    ? undefined
    : prepared;
}

/** The child a container draws first, in the scope and path the renderer gives it. */
function leadingChild(
  styled: Raw,
  scope: WebRenderScope,
  path: string,
  outermostStack: boolean,
): WebChildEntry | undefined {
  switch (styled.type) {
    case "pager": {
      const pages = Array.isArray(styled.children) ? styled.children : [];
      const page = pagerPage(styled, scope, { bound });
      return { node: pages[page], scope, path: `${path}.children[${page}]` };
    }
    case "scroll":
    case "bottomSheet":
      return { node: styled.child, scope, path: `${path}.child` };
    case "stack": {
      const screen = stackScreen(styled, scope, outermostStack);
      return screen === undefined
        ? undefined
        : {
            node: record(styled.screens)?.[screen],
            scope,
            path: `${path}.screens[${JSON.stringify(screen)}]`,
          };
    }
    default:
      // A repeat's template counts only through the rows it draws, bound to each row.
      return childEntries(styled, scope, path).find(
        (entry) => drawnNode(entry.node, entry.scope, entry.path) !== undefined,
      );
  }
}
