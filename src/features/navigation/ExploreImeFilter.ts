import type { ObserveResult, ViewHierarchyResult } from "../../models";
import { beginPostActionCaptureAction } from "../../utils/PostActionCaptureContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { resolveViewHierarchyForSearch } from "../../utils/viewHierarchySearch";

/** `AccessibilityWindowInfo.TYPE_INPUT_METHOD`. */
const INPUT_METHOD_WINDOW_TYPE = 2;
/** CtrlProxy's window extra naming the IME package on the keyboard window's root. */
const IME_PACKAGE_EXTRA = "automobile:imePackage";

interface ImeWindowMarkers {
  ids: ReadonlySet<number>;
  roots: ReadonlySet<unknown>;
}

function imeWindowMarkers(viewHierarchy: ViewHierarchyResult): ImeWindowMarkers {
  const imeWindows = (viewHierarchy.windows ?? []).filter(
    (window) => window.type === INPUT_METHOD_WINDOW_TYPE,
  );
  return {
    ids: new Set(imeWindows.flatMap((window) => (window.id === undefined ? [] : [window.id]))),
    roots: new Set(imeWindows.flatMap((window) => (window.hierarchy ? [window.hierarchy] : []))),
  };
}

type RawNode = Record<string, unknown>;

/**
 * Positive IME ownership only: the node is an input-method window root by the
 * capture's window list (linked root object or `windowId`), or carries
 * CtrlProxy's `automobile:imePackage` extra. Never inferred from position.
 */
function isImeWindowRoot(node: RawNode, markers: ImeWindowMarkers): boolean {
  if (markers.roots.has(node)) {
    return true;
  }
  const attributes: RawNode = isRawNode(node.$) ? node.$ : node;
  const windowId = node.windowId ?? attributes.windowId;
  if (typeof windowId === "number" && markers.ids.has(windowId)) {
    return true;
  }
  const imePackage = isRawNode(attributes.extras)
    ? attributes.extras[IME_PACKAGE_EXTRA]
    : undefined;
  return typeof imePackage === "string" && imePackage.length > 0;
}

function isRawNode(value: unknown): value is RawNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pruneChildren(children: unknown, markers: ImeWindowMarkers): unknown {
  if (Array.isArray(children)) {
    return children.flatMap((child: unknown) => {
      const pruned = pruneNode(child, markers);
      return pruned === undefined ? [] : [pruned];
    });
  }
  return pruneNode(children, markers);
}

/** A copy of `node` without input-method subtrees; undefined when `node` is one. */
function pruneNode(node: unknown, markers: ImeWindowMarkers): unknown {
  if (!isRawNode(node)) {
    return node;
  }
  if (isImeWindowRoot(node, markers)) {
    return undefined;
  }
  const copy: RawNode = { ...node };
  for (const key of ["node", "children"]) {
    if (key in node) {
      copy[key] = pruneChildren(node[key], markers);
    }
  }
  return copy;
}

/**
 * The capture without its input-method windows, so explore never picks a
 * soft-keyboard key (Gboard/LatinIME `key_pos_*`) as a navigation candidate
 * (#17377). Driving a keyboard is `sendKeys`, never an exploration step. The
 * result is a copy; nodes outside input-method windows keep their attributes.
 */
export function withoutImeWindows(viewHierarchy: ViewHierarchyResult): ViewHierarchyResult {
  const source = resolveViewHierarchyForSearch(viewHierarchy) ?? viewHierarchy;
  const markers = imeWindowMarkers(source);
  const hierarchy = pruneNode(source.hierarchy, markers);
  return {
    ...source,
    hierarchy: isRawNode(hierarchy) ? (hierarchy as ViewHierarchyResult["hierarchy"]) : {},
    ...(source.windows
      ? {
          windows: source.windows.filter((window) => window.type !== INPUT_METHOD_WINDOW_TYPE),
        }
      : {}),
  };
}

/**
 * Whether the capture shows a soft keyboard over the app under test: an
 * input-method window is listed and the app's own window is beneath it. Explore
 * then presses back once to hide the keyboard instead of exploring its keys.
 */
export function showsImeOverApp(viewHierarchy: ViewHierarchyResult, appPackage: string): boolean {
  const windows = viewHierarchy.windows ?? [];
  if (!windows.some((window) => window.type === INPUT_METHOD_WINDOW_TYPE)) {
    return false;
  }
  return (
    viewHierarchy.packageName === appPackage ||
    windows.some(
      (window) => window.type !== INPUT_METHOD_WINDOW_TYPE && window.packageName === appPackage,
    )
  );
}

/**
 * Hides a soft keyboard opened over the app under test (a search field took
 * focus) with one unrecorded back press, so explore keeps exploring the app
 * instead of the keyboard (#17377). If the keyboard is still shown after that
 * press, explore continues with its keys excluded from the candidates, and back
 * is not pressed again until the keyboard has hidden.
 */
export class ExploreImeDismissal {
  private backPressed = false;

  reset(): void {
    this.backPressed = false;
  }

  /** True when back was pressed and the screen should be observed again. */
  async dismiss(
    observation: ObserveResult,
    targetPackage: string,
    pressBack: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const shown =
      observation.viewHierarchy !== undefined &&
      showsImeOverApp(observation.viewHierarchy, targetPackage);
    if (!shown || this.backPressed) {
      this.backPressed = shown;
      return false;
    }
    this.backPressed = true;
    logger.info("[Explore] Soft keyboard is open over the app; pressing back to hide it");
    try {
      // Recovery dispatches bypass BaseVisualChange's action boundary.
      await beginPostActionCaptureAction();
      await pressBack();
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Keyboard keys are already excluded from candidates, so exploring on is safe.
      logger.warn(
        `[Explore] Back press to hide the keyboard failed: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
    return true;
  }
}
