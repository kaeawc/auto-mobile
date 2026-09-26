import type { BootedDevice, ViewHierarchyResult, ViewHierarchyNode } from "../../models";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../observe/android";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { DefaultElementParser } from "../utility/ElementParser";
import { AndroidImeCatalog, type ImeCatalogState } from "./AndroidImeCatalog";
import { Keyboard } from "./Keyboard";
import { TapAtCoordinate } from "./TapAtCoordinate";
import { quarantineAndroidIme, withAndroidImeLock } from "./androidImeLock";

const READY_TIMEOUT_MS = 2_000;
const READY_POLL_MS = 100;

export interface InstalledImeKeySessionDependencies {
  catalog: Pick<AndroidImeCatalog, "list" | "selectWithinLock">;
  keyboard: {
    execute(action: "open", signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
  };
  hierarchy: { read(signal?: AbortSignal): Promise<ViewHierarchyResult | null> };
  tap: {
    execute(
      options: { x: number; y: number },
      progress?: undefined,
      signal?: AbortSignal,
    ): Promise<{ success: boolean; error?: string }>;
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
  ): Promise<{ imeId: string; key: string; x: number; y: number }> {
    if (!key.trim()) {
      throw new Error("IME key label must be non-empty.");
    }
    return withAndroidImeLock(this.deviceId, () => this.tapKeyLocked(imeId, key, signal), signal);
  }

  private async tapKeyLocked(imeId: string, key: string, signal?: AbortSignal) {
    const { catalog } = this.dependencies;
    const before = await this.validateStartingState(imeId, signal);
    const original = before.activeImeId!;
    let result: { imeId: string; key: string; x: number; y: number } | undefined;
    let failure: unknown;
    try {
      result = await this.performTap(imeId, key, signal);
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
  ): Promise<ImeCatalogState> {
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
    if (!initialHierarchy || !new DefaultElementFinder().findFocusedTextInput(initialHierarchy)) {
      throw new Error("Focus a text input before tapping a native IME key.");
    }
    return before;
  }

  private async performTap(imeId: string, key: string, signal?: AbortSignal) {
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
    return { imeId, key, ...point };
  }

  private async waitForVisibleKey(imeId: string, key: string, signal?: AbortSignal) {
    const { hierarchy, timer } = this.dependencies;
    const deadline = timer.now() + READY_TIMEOUT_MS;
    do {
      signal?.throwIfAborted();
      const current = await hierarchy.read(signal);
      const point = current ? findVisibleImeKey(current, imeId, key) : null;
      if (point) {
        return point;
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
  const matches: Array<{ x: number; y: number }> = [];
  for (const window of hierarchy.windows ?? []) {
    if (
      window.type !== 2 ||
      !window.hierarchy ||
      !window.bounds ||
      (window.packageName && window.packageName !== packageName)
    ) {
      continue;
    }
    const bounds = window.bounds;
    parser.traverseNode(window.hierarchy, (node: ViewHierarchyNode) => {
      const properties = parser.extractNodeProperties(node);
      if (
        properties.text !== key &&
        properties["content-desc"] !== key &&
        properties.contentDesc !== key
      ) {
        return;
      }
      const candidate = parser.parseBounds(node.bounds ?? properties.bounds);
      if (!candidate || candidate.right <= candidate.left || candidate.bottom <= candidate.top) {
        return;
      }
      const x = Math.round((candidate.left + candidate.right) / 2);
      const y = Math.round((candidate.top + candidate.bottom) / 2);
      if (x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom) {
        matches.push({ x, y });
      }
    });
  }
  return matches.length === 1 ? matches[0] : null;
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
    tap: new TapAtCoordinate(device),
    timer: defaultTimer,
  });
}
