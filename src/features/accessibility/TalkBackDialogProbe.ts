import type { BootedDevice } from "../../models";
import type { AccessibilityNode } from "../observe/android/types";
import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../observe/android";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

const PROBE_TIMEOUT_MS = 3000;
const CONSENT_BUTTON_ID = "android:id/button1";

/**
 * What a probe saw. `unavailable` means CtrlProxy could not answer, which is
 * different from `none`: only then may the toggle spend its single `uiautomator
 * dump` (#10147).
 */
export type TalkBackDialogProbeResult =
  | { kind: "dialog"; tap: { x: number; y: number } | null }
  | { kind: "none" }
  | { kind: "unavailable" };

/**
 * Narrow seam for looking for the TalkBack consent dialog without `uiautomator
 * dump`. A dump registers a `UiAutomation` that suspends every other
 * accessibility service while it is connected, so it restarts CtrlProxy and the
 * TalkBack service the caller has just enabled (#9758, #10147).
 */
export interface TalkBackDialogProbe {
  probe(): Promise<TalkBackDialogProbeResult>;
}

function childrenOf(node: AccessibilityNode): AccessibilityNode[] {
  if (!node.node) {
    return [];
  }
  return Array.isArray(node.node) ? node.node : [node.node];
}

function collectNodes(root: AccessibilityNode): AccessibilityNode[] {
  const nodes: AccessibilityNode[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    pending.push(...childrenOf(node));
  }
  return nodes;
}

/**
 * The captured hierarchy is one tree whose children are every window's root, each
 * carrying the native `windowId` marker. A tree without markers is a single window.
 */
function windowRoots(root: AccessibilityNode): AccessibilityNode[] {
  const roots: AccessibilityNode[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.windowId !== undefined) {
      roots.push(node);
    } else {
      pending.push(...childrenOf(node));
    }
  }
  return roots.length > 0 ? roots : [root];
}

function findConsentButtonInWindow(window: AccessibilityNode): AccessibilityNode | undefined {
  const nodes = collectNodes(window);
  const mentionsTalkBack = nodes.some(
    (node) => node.text?.includes("TalkBack") || node["content-desc"]?.includes("TalkBack"),
  );
  return mentionsTalkBack
    ? nodes.find((node) => node["resource-id"] === CONSENT_BUTTON_ID)
    : undefined;
}

/**
 * Match `android:id/button1` only when the TalkBack dialog context is present in
 * the SAME window: that id is a generic one reused by many dialogs, so a TalkBack
 * mention in one window must never select another window's OK button. Matching by
 * id keeps the tap locale independent.
 */
export function findTalkBackConsentDialog(root: AccessibilityNode): TalkBackDialogProbeResult {
  const button = windowRoots(root)
    .map(findConsentButtonInWindow)
    .find((candidate) => candidate !== undefined);
  if (!button) {
    return { kind: "none" };
  }
  const bounds = button.bounds;
  return {
    kind: "dialog",
    tap: bounds
      ? {
          x: Math.round((bounds.left + bounds.right) / 2),
          y: Math.round((bounds.top + bounds.bottom) / 2),
        }
      : null,
  };
}

/** Reads the CtrlProxy accessibility hierarchy, which never restarts an accessibility service. */
export class CtrlProxyTalkBackDialogProbe implements TalkBackDialogProbe {
  constructor(
    private readonly device: BootedDevice,
    // Resolve lazily so the singleton is only touched when a probe actually runs.
    private readonly clientProvider: () => Pick<
      AndroidCtrlProxy,
      "requestHierarchySyncWithoutObservationStreamPush"
    > = () => AndroidCtrlProxyClient.getInstance(this.device),
  ) {}

  async probe(): Promise<TalkBackDialogProbeResult> {
    try {
      const sync = await this.clientProvider().requestHierarchySyncWithoutObservationStreamPush(
        undefined,
        true,
        undefined,
        PROBE_TIMEOUT_MS,
      );
      const root = sync?.hierarchy.hierarchy;
      return root ? findTalkBackConsentDialog(root) : { kind: "unavailable" };
    } catch (error) {
      logger.warn(`[TalkBackDialogProbe] CtrlProxy hierarchy unavailable: ${errorMessage(error)}`);
      return { kind: "unavailable" };
    }
  }
}
