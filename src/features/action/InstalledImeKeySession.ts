import type { BootedDevice, ViewHierarchyResult, ViewHierarchyNode } from "../../models";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import { ActionableError } from "../../models/ActionableError";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { DefaultElementParser } from "../utility/ElementParser";
import { toSearchable } from "../utility/SearchableNode";
import {
  AndroidImeCatalog,
  AUTO_MOBILE_IME_ID,
  type ImeCatalogState,
  type ImeSubtypeSnapshot,
  type KeyboardIdentity,
} from "./AndroidImeCatalog";
import { Keyboard } from "./Keyboard";
import { quarantineAndroidIme, withAndroidImeLock } from "./androidImeLock";

const READY_TIMEOUT_MS = 2_000;
const READY_POLL_MS = 100;
const ENABLED_DRIFT_DIAGNOSTIC_MAX_CHARS = 512;

export class ImeSessionFocusLostError extends ActionableError {
  constructor(readonly reason: "editorFocusLost" | "imeWindowDisappeared") {
    super(
      reason === "editorFocusLost"
        ? "Focused text input lost focus while waiting for a visible IME key."
        : "Selected IME window disappeared while waiting for a visible key.",
    );
    this.name = "ImeSessionFocusLostError";
  }
}

interface FrameBoundKeyPoint {
  x: number;
  y: number;
  frameContext: string;
}
export type EditorVerification =
  | { status: "changed" | "unchanged" }
  | { status: "unavailable"; reason: string };

export async function tapFrameBoundImeKey(
  client: Pick<AndroidCtrlProxyClient, "requestTapCoordinates">,
  point: FrameBoundKeyPoint,
): Promise<{ success: boolean; error?: string }> {
  if (typeof point.frameContext !== "string" || !point.frameContext.trim()) {
    return { success: false, error: "The IME key observation has no frame context." };
  }
  // The runner rejects a stale context before dispatch. Never retry or fall back to ADB.
  return client.requestTapCoordinates(
    point.x,
    point.y,
    10,
    undefined,
    undefined,
    point.frameContext,
  );
}

export interface InstalledImeKeySessionDependencies {
  catalog: Pick<
    AndroidImeCatalog,
    "list" | "selectWithinLock" | "readSubtype" | "restoreSubtypeWithinLock" | "identity"
  >;
  keyboard: {
    execute(action: "open", signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
  };
  hierarchy: { read(signal?: AbortSignal): Promise<ViewHierarchyResult | null> };
  tap: {
    execute(point: FrameBoundKeyPoint): Promise<{ success: boolean; error?: string }>;
  };
  timer: Timer;
}

/** One physical tap on a key in a real installed IME, with device-global restoration. */
export class InstalledImeKeySession {
  constructor(
    private readonly deviceId: string,
    private readonly dependencies: InstalledImeKeySessionDependencies,
  ) {}

  async tapKey(
    imeId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{
    imeId: string;
    key: string;
    x: number;
    y: number;
    editorVerification: EditorVerification;
    backend: "installedIme";
    capability: "visibleKeyTap";
    keyboard: KeyboardIdentity;
  }> {
    if (!key.trim()) {
      throw new Error("IME key label must be non-empty.");
    }
    return withAndroidImeLock(this.deviceId, () => this.tapKeyLocked(imeId, key, signal), signal);
  }

  private async tapKeyLocked(imeId: string, key: string, signal?: AbortSignal) {
    const { catalog } = this.dependencies;
    const { before, subtype, editorBefore } = await this.validateStartingState(imeId, signal);
    const original = before.activeImeId!;
    let result: Awaited<ReturnType<typeof this.performTap>> | undefined;
    let failure: unknown;
    try {
      result = await this.performTap(imeId, key, editorBefore, signal);
    } catch (error) {
      failure = error;
    }

    // Cleanup deliberately ignores cancellation: the same device lock remains held until
    // the original component and enabled set have been verified.
    try {
      let componentError: unknown;
      try {
        await catalog.selectWithinLock(original);
      } catch (error) {
        componentError = error;
      }
      try {
        // The subtype write must run after the component, even if selection rejects.
        await catalog.restoreSubtypeWithinLock(original, subtype);
      } catch (error) {
        if (componentError !== undefined) {
          throw new AggregateError(
            [componentError, error],
            "IME component and subtype restoration failed.",
          );
        }
        throw error;
      }
      if (componentError !== undefined) {
        throw componentError;
      }
      const after = await catalog.list();
      if (after.activeImeId !== original || !sameEnabledSet(before, after)) {
        // This session never enables/disables IMEs; external drift is reported, never repaired.
        throw new Error(
          `IME state did not return to its original active and enabled state${enabledSetDriftDiagnostic(before, after)}.`,
        );
      }
    } catch (restoreError) {
      quarantineAndroidIme(this.deviceId);
      throw new AggregateError(
        failure === undefined ? [restoreError] : [failure, restoreError],
        `Could not restore the original keyboard ${original}; run "keyboard setIme ${original}" or restart the daemon.`,
      );
    }
    if (failure !== undefined) {
      throw failure;
    }
    return result!;
  }

  private async validateStartingState(
    imeId: string,
    signal?: AbortSignal,
  ): Promise<{
    before: ImeCatalogState;
    subtype: ImeSubtypeSnapshot;
    editorBefore: FocusedEditorEvidence | null;
  }> {
    const { catalog, hierarchy } = this.dependencies;
    const before = await catalog.list(signal);
    const original = before.activeImeId;
    if (!original || !before.installed.some((ime) => ime.id === original && ime.enabled)) {
      throw new Error("Cannot restore the active IME: no enabled active component was reported.");
    }
    if (!before.installed.some((ime) => ime.id === imeId && ime.enabled)) {
      throw new Error(`IME ${imeId} is not installed and enabled on this device.`);
    }
    if (imeId === AUTO_MOBILE_IME_ID) {
      throw new Error(
        "AutoMobile IME does not support visibleKeyTap; use sendKeys mode: ime for semanticText.",
      );
    }
    const subtype = await catalog.readSubtype(original, signal);
    const initialHierarchy = await hierarchy.read(signal);
    const editorBefore = initialHierarchy ? focusedEditorEvidence(initialHierarchy) : null;
    if (!initialHierarchy || !new DefaultElementFinder().findFocusedTextInput(initialHierarchy)) {
      throw new Error("Focus a text input before tapping a native IME key.");
    }
    return { before, subtype, editorBefore };
  }

  private async performTap(
    imeId: string,
    key: string,
    editorBefore: FocusedEditorEvidence | null,
    signal?: AbortSignal,
  ) {
    const { catalog, keyboard, tap } = this.dependencies;
    signal?.throwIfAborted();
    await catalog.selectWithinLock(imeId, signal);
    signal?.throwIfAborted();
    // Cancellation reaches the open poll; restoration still runs afterwards under the held lock.
    const opened = await keyboard.execute("open", signal);
    // A cancelled open can report a failed result; surface the cancellation instead.
    signal?.throwIfAborted();
    if (!opened.success) {
      throw new Error(opened.error ?? "Could not open the selected IME.");
    }
    const point = await this.waitForVisibleKey(imeId, key, signal);
    const active = await catalog.list(signal);
    if (active.activeImeId !== imeId) {
      throw new Error("The active IME changed before the key tap.");
    }
    signal?.throwIfAborted();
    // A dispatched physical tap must settle before the IME can be restored.
    const tapped = await tap.execute(point);
    if (!tapped.success) {
      throw new Error(tapped.error ?? "Native IME key tap failed.");
    }
    // The tap has already reached the runner. Finish verification and restoration even if
    // cancellation arrives now, so callers do not mistake an applied key for a canceled one.
    const editorVerification = await this.verifyEditorAfterTap(editorBefore);
    const subtype = await catalog.readSubtype(imeId);
    const identity = await catalog.identity(imeId, subtype);
    return {
      imeId,
      key,
      x: point.x,
      y: point.y,
      editorVerification,
      backend: "installedIme" as const,
      capability: "visibleKeyTap" as const,
      keyboard: identity,
    };
  }

  private async verifyEditorAfterTap(
    before: FocusedEditorEvidence | null,
  ): Promise<EditorVerification> {
    if (!before) {
      return {
        status: "unavailable",
        reason: "Focused editor identity or text was unavailable before the tap.",
      };
    }
    try {
      const afterHierarchy = await this.dependencies.hierarchy.read();
      const after = afterHierarchy ? focusedEditorEvidence(afterHierarchy) : null;
      if (!after || after.identity !== before.identity) {
        return {
          status: "unavailable",
          reason: "The same focused editor was not observable after the tap.",
        };
      }
      return { status: after.text === before.text ? "unchanged" : "changed" };
    } catch (error) {
      logger.warn(
        `Focused editor observation failed after native IME tap (${error instanceof Error ? error.name : typeof error}).`,
      );
      return { status: "unavailable", reason: "Focused editor observation failed after the tap." };
    }
  }

  private async waitForVisibleKey(imeId: string, key: string, signal?: AbortSignal) {
    const { hierarchy, timer } = this.dependencies;
    const deadline = timer.now() + READY_TIMEOUT_MS;
    let seen = { focusedEditor: false, imeWindow: false };
    do {
      signal?.throwIfAborted();
      const current = await hierarchy.read(signal);
      const point = current ? findVisibleImeKey(current, imeId, key) : null;
      if (point) {
        if (!current?.frameContext?.trim()) {
          throw new Error(
            "The visible IME key observation has no frame context; refusing an unbound tap.",
          );
        }
        return { ...point, frameContext: current.frameContext };
      }
      if (current) {
        seen = observeImeWaitFocus(current, imeId, seen);
      }
      const remaining = deadline - timer.now();
      if (remaining <= 0) {
        break;
      }
      await timer.sleep(Math.min(READY_POLL_MS, remaining));
    } while (timer.now() < deadline);
    if (!seen.imeWindow) {
      throw new Error(`Selected IME window did not appear within ${READY_TIMEOUT_MS} ms.`);
    }
    throw new Error(`Visible key ${JSON.stringify(key)} was not found in the selected IME window.`);
  }
}

function observeImeWaitFocus(
  current: ViewHierarchyResult,
  imeId: string,
  seen: { focusedEditor: boolean; imeWindow: boolean },
) {
  const focusedEditor = Boolean(new DefaultElementFinder().findFocusedTextInput(current));
  const imeWindow = matchingImeWindows(current, imeId).length > 0;
  if (seen.focusedEditor && !focusedEditor) {
    throw new ImeSessionFocusLostError("editorFocusLost");
  }
  if (seen.imeWindow && !imeWindow) {
    throw new ImeSessionFocusLostError("imeWindowDisappeared");
  }
  return {
    focusedEditor: seen.focusedEditor || focusedEditor,
    imeWindow: seen.imeWindow || imeWindow,
  };
}

interface FocusedEditorEvidence {
  identity: string;
  text: string;
}
function focusedEditorEvidence(hierarchy: ViewHierarchyResult): FocusedEditorEvidence | null {
  const editor = new DefaultElementFinder().findFocusedTextInput(hierarchy);
  const identity = editor?.["resource-id"] ?? editor?.["view-id"];
  return typeof identity === "string" && identity && typeof editor.text === "string"
    ? { identity, text: editor.text }
    : null;
}

function sameEnabledSet(before: ImeCatalogState, after: ImeCatalogState): boolean {
  const { added, removed } = diffEnabledSet(before, after);
  return added.length === 0 && removed.length === 0;
}

export function diffEnabledSet(
  before: ImeCatalogState,
  after: ImeCatalogState,
): {
  added: string[];
  removed: string[];
} {
  const enabled = (state: ImeCatalogState) =>
    new Set(state.installed.filter((ime) => ime.enabled).map((ime) => ime.id));
  const beforeIds = enabled(before);
  const afterIds = enabled(after);
  return {
    added: [...afterIds].filter((id) => !beforeIds.has(id)).sort(),
    removed: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
  };
}

function enabledSetDriftDiagnostic(before: ImeCatalogState, after: ImeCatalogState): string {
  const drift = diffEnabledSet(before, after);
  const ids = [...drift.added.map((id) => `+${id}`), ...drift.removed.map((id) => `-${id}`)].join(
    ", ",
  );
  const boundedIds =
    ids.length > ENABLED_DRIFT_DIAGNOSTIC_MAX_CHARS
      ? `${ids.slice(0, ENABLED_DRIFT_DIAGNOSTIC_MAX_CHARS - 3)}...`
      : ids;
  return ids ? ` (enabled set drift: ${boundedIds})` : "";
}

function findVisibleImeKey(
  hierarchy: ViewHierarchyResult,
  imeId: string,
  key: string,
): { x: number; y: number } | null {
  const parser = new DefaultElementParser();
  const packageName = imeId.slice(0, imeId.indexOf("/"));
  const imeWindows = matchingImeWindows(hierarchy, imeId);
  if (imeWindows.length === 0) {
    return null;
  }
  const matches: Array<{ x: number; y: number }> = [];
  // CtrlProxy can flatten all window nodes into the root hierarchy while retaining
  // only bounds/type metadata for each window. Traverse those nodes once, then
  // require both target-package ownership and containment in a real IME window.
  for (const root of parser.extractRootNodes(hierarchy)) {
    const ownedAtDepth: boolean[] = [];
    const matchedAtDepth: boolean[] = [];
    parser.traverseNode(root, (node: ViewHierarchyNode, depth: number) => {
      const properties = parser.extractNodeProperties(node);
      const searchable = toSearchable(properties);
      const owned = isOwnedByIme(
        properties,
        packageName,
        searchable.nativeId,
        ownedAtDepth[depth - 1],
      );
      ownedAtDepth[depth] = owned;
      const point = matchingImeKeyCenter(node, properties, parser, key, owned, imeWindows);
      const ancestorMatched = matchedAtDepth[depth - 1] ?? false;
      matchedAtDepth[depth] = ancestorMatched || point !== null;
      if (point && !ancestorMatched) {
        matches.push(point);
      }
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function matchingImeWindows(hierarchy: ViewHierarchyResult, imeId: string) {
  const packageName = imeId.slice(0, imeId.indexOf("/"));
  return (hierarchy.windows ?? []).filter(
    (window) =>
      window.type === 2 &&
      window.bounds &&
      (!window.packageName || window.packageName === packageName),
  );
}

function matchingImeKeyCenter(
  node: ViewHierarchyNode,
  properties: Record<string, unknown>,
  parser: DefaultElementParser,
  key: string,
  owned: boolean,
  windows: NonNullable<ViewHierarchyResult["windows"]>,
): { x: number; y: number } | null {
  const searchable = toSearchable(properties);
  if (!Object.values(searchable.textSources).includes(key) && properties.contentDesc !== key) {
    return null;
  }
  if (!owned) {
    return null;
  }
  const candidate = parser.parseBounds(nodeBounds(node));
  if (!candidate || candidate.right <= candidate.left || candidate.bottom <= candidate.top) {
    return null;
  }
  const x = Math.round((candidate.left + candidate.right) / 2);
  const y = Math.round((candidate.top + candidate.bottom) / 2);
  return windows.some(
    ({ bounds }) =>
      bounds && x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom,
  )
    ? { x, y }
    : null;
}

function isOwnedByIme(
  properties: Record<string, unknown>,
  packageName: string,
  resourceId: string | undefined,
  inherited = false,
): boolean {
  const nodePackage = properties.package;
  const marker = (properties.extras as Record<string, unknown> | undefined)?.[
    "automobile:imePackage"
  ];
  if (typeof marker === "string" && marker !== packageName) {
    return false;
  }
  if (typeof resourceId === "string" && !resourceId.startsWith(`${packageName}:`)) {
    return false;
  }
  if (typeof nodePackage === "string" && nodePackage !== packageName) {
    return false;
  }
  return (
    marker === packageName ||
    nodePackage === packageName ||
    typeof resourceId === "string" ||
    inherited
  );
}

export function createInstalledImeKeySession(device: BootedDevice): InstalledImeKeySession {
  const adb = defaultAdbClientFactory.create(device);
  const viewHierarchy = new ViewHierarchy(device);
  const cache = AndroidCtrlProxyClient.getInstance(device);
  return new InstalledImeKeySession(device.deviceId, {
    catalog: new AndroidImeCatalog(adb, device.deviceId),
    keyboard: new Keyboard(device),
    hierarchy: {
      read: (signal) => {
        cache.invalidateCache();
        return viewHierarchy.getViewHierarchy(
          undefined,
          new NoOpPerformanceTracker(),
          false,
          0,
          signal,
          READY_TIMEOUT_MS,
        );
      },
    },
    tap: { execute: (point) => tapFrameBoundImeKey(cache, point) },
    timer: defaultTimer,
  });
}
