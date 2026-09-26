import type { BootedDevice, ViewHierarchyResult, ViewHierarchyNode } from "../../models";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { DefaultElementParser } from "../utility/ElementParser";
import { AndroidImeCatalog, type ImeCatalogState } from "./AndroidImeCatalog";
import { Keyboard } from "./Keyboard";
import { quarantineAndroidIme, withAndroidImeLock } from "./androidImeLock";

const READY_TIMEOUT_MS = 2_000;
const READY_POLL_MS = 100;

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
  catalog: Pick<AndroidImeCatalog, "list" | "selectWithinLock">;
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
  }> {
    if (!key.trim()) {
      throw new Error("IME key label must be non-empty.");
    }
    return withAndroidImeLock(this.deviceId, () => this.tapKeyLocked(imeId, key, signal), signal);
  }

  private async tapKeyLocked(imeId: string, key: string, signal?: AbortSignal) {
    const { catalog } = this.dependencies;
    const { before, editorBefore } = await this.validateStartingState(imeId, signal);
    const original = before.activeImeId!;
    let result:
      | { imeId: string; key: string; x: number; y: number; editorVerification: EditorVerification }
      | undefined;
    let failure: unknown;
    try {
      result = await this.performTap(imeId, key, editorBefore, signal);
    } catch (error) {
      failure = error;
    }

    // Cleanup deliberately ignores cancellation: the same device lock remains held until
    // the original component and enabled set have been verified.
    try {
      await catalog.selectWithinLock(original);
      const after = await catalog.list();
      if (after.activeImeId !== original || !sameEnabledSet(before, after)) {
        throw new Error("IME state did not return to its original active and enabled state.");
      }
    } catch (restoreError) {
      quarantineAndroidIme(this.deviceId);
      throw new AggregateError(
        failure === undefined ? [restoreError] : [failure, restoreError],
        "Native IME session could not verify restoration; restart AutoMobile before changing IMEs.",
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
  ): Promise<{ before: ImeCatalogState; editorBefore: FocusedEditorEvidence | null }> {
    const { catalog, hierarchy } = this.dependencies;
    const before = await catalog.list(signal);
    const original = before.activeImeId;
    if (!original || !before.installed.some((ime) => ime.id === original && ime.enabled)) {
      throw new Error("Cannot restore the active IME: no enabled active component was reported.");
    }
    if (!before.installed.some((ime) => ime.id === imeId && ime.enabled)) {
      throw new Error(`IME ${imeId} is not installed and enabled on this device.`);
    }
    const initialHierarchy = await hierarchy.read(signal);
    const editorBefore = initialHierarchy ? focusedEditorEvidence(initialHierarchy) : null;
    if (!initialHierarchy || !new DefaultElementFinder().findFocusedTextInput(initialHierarchy)) {
      throw new Error("Focus a text input before tapping a native IME key.");
    }
    return { before, editorBefore };
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
    // Once focus activation starts, wait for it to settle before any restoration.
    const opened = await keyboard.execute("open");
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
    signal?.throwIfAborted();
    const editorVerification = await this.verifyEditorAfterTap(editorBefore);
    signal?.throwIfAborted();
    return { imeId, key, x: point.x, y: point.y, editorVerification };
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
      const remaining = deadline - timer.now();
      if (remaining <= 0) {
        break;
      }
      await timer.sleep(Math.min(READY_POLL_MS, remaining));
    } while (timer.now() < deadline);
    throw new Error(`Visible key ${JSON.stringify(key)} was not found in the selected IME window.`);
  }
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
  const enabled = (state: ImeCatalogState) =>
    state.installed
      .filter((ime) => ime.enabled)
      .map((ime) => ime.id)
      .sort();
  return JSON.stringify(enabled(before)) === JSON.stringify(enabled(after));
}

function findVisibleImeKey(
  hierarchy: ViewHierarchyResult,
  imeId: string,
  key: string,
): { x: number; y: number } | null {
  const parser = new DefaultElementParser();
  const packageName = imeId.slice(0, imeId.indexOf("/"));
  const imeWindows = (hierarchy.windows ?? []).filter(
    (window) =>
      window.type === 2 &&
      window.bounds &&
      (!window.packageName || window.packageName === packageName),
  );
  if (imeWindows.length === 0) {
    return null;
  }
  const matches: Array<{ x: number; y: number }> = [];
  // CtrlProxy can flatten all window nodes into the root hierarchy while retaining
  // only bounds/type metadata for each window. Traverse those nodes once, then
  // require both target-package ownership and containment in a real IME window.
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const properties = parser.extractNodeProperties(node);
      const point = matchingImeKeyCenter(node, properties, parser, key, packageName, imeWindows);
      if (point) {
        matches.push(point);
      }
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function matchingImeKeyCenter(
  node: ViewHierarchyNode,
  properties: Record<string, unknown>,
  parser: DefaultElementParser,
  key: string,
  packageName: string,
  windows: NonNullable<ViewHierarchyResult["windows"]>,
): { x: number; y: number } | null {
  if (
    properties.text !== key &&
    properties["content-desc"] !== key &&
    properties.contentDesc !== key
  ) {
    return null;
  }
  if (!isOwnedByIme(properties, packageName)) {
    return null;
  }
  const candidate = parser.parseBounds(node.bounds ?? properties.bounds);
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

function isOwnedByIme(properties: Record<string, unknown>, packageName: string): boolean {
  const resourceId = properties["resource-id"] ?? properties.resourceId;
  const nodePackage = properties.package;
  if (typeof resourceId !== "string" && nodePackage !== packageName) {
    return false;
  }
  if (typeof resourceId === "string" && !resourceId.startsWith(`${packageName}:`)) {
    return false;
  }
  return typeof nodePackage !== "string" || nodePackage === packageName;
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
