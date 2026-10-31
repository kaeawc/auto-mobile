import type { ElementBounds } from "../../models/ElementBounds";
import type { LauncherRefreshGate } from "./LauncherRefreshGate";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { textOrDescription, type SearchableEntry } from "../utility/SearchableNode";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { KNOWN_ANDROID_LAUNCHER_PACKAGES } from "../observe/androidLauncherRegistry";

export const MAX_WORKSPACE_PAGES = 10;

export const LAUNCHER_SETTLE_POLL_MS = 250;
export const LAUNCHER_SETTLE_TIMEOUT_MS = 5000;

/** What the host needs from the device to refresh the launcher after a shortcut change (#14887). */
export interface LauncherRefreshDriver {
  capture: HierarchyCapture;
  deviceKey: string;
  gate: LauncherRefreshGate;
  /** Swipe right to left using the captured root bounds. */
  swipeWorkspaceToNextPage(bounds: ElementBounds): Promise<void>;
  timer: Timer;
  /** The configured HOME launcher package, or null when it cannot be resolved. */
  resolveLauncher(): Promise<string | null>;
  /** Force-stops the launcher package and sends the HOME intent; throws on failure. */
  restartLauncher(launcherPackage: string): Promise<void>;
}

export interface LauncherRefreshOutcome {
  launcherRestarted: boolean;
  shortcutVisible: boolean;
  /** Present whenever the shortcut is not confirmed visible: why, and what to do. */
  message?: string;
}

const labelOf = (entry: SearchableEntry): string => textOrDescription(entry).trim();

function isShortcutShown(nodes: readonly SearchableEntry[], label: string): boolean {
  const wanted = label.trim().toLowerCase();
  return nodes.some(
    (entry) => entry.bounds !== undefined && labelOf(entry).toLowerCase() === wanted,
  );
}

function treeSignature(nodes: readonly SearchableEntry[]): string {
  return nodes
    .map((entry) => {
      const b = entry.bounds;
      return `${labelOf(entry)}@${b ? `${b.left},${b.top},${b.right},${b.bottom}` : ""}`;
    })
    .join("|");
}

/** Polls until two consecutive captures match (the launcher's quiet tree) or the budget ends. */
async function waitForQuietLauncher(
  driver: LauncherRefreshDriver,
  signal: AbortSignal | undefined,
): Promise<readonly SearchableEntry[]> {
  const deadline = driver.timer.now() + LAUNCHER_SETTLE_TIMEOUT_MS;
  let previous: string | undefined;
  while (true) {
    signal?.throwIfAborted();
    const { nodes } = await driver.capture.capture({ freshness: "fresh", signal });
    const signature = treeSignature(nodes);
    if (signature === previous || driver.timer.now() + LAUNCHER_SETTLE_POLL_MS > deadline) {
      return nodes;
    }
    previous = signature;
    await driver.timer.sleep(LAUNCHER_SETTLE_POLL_MS);
  }
}

/** Searches the current workspace and following pages, stopping at the edge or the bound. */
async function scanWorkspace(
  driver: LauncherRefreshDriver,
  first: readonly SearchableEntry[],
  label: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let nodes = first;
  for (let page = 1; page <= MAX_WORKSPACE_PAGES; page++) {
    signal?.throwIfAborted();
    if (isShortcutShown(nodes, label)) {
      return true;
    }
    const bounds = nodes.find((node) => node.parentIndex === undefined)?.bounds;
    if (
      !bounds ||
      bounds.right <= bounds.left ||
      bounds.bottom <= bounds.top ||
      page === MAX_WORKSPACE_PAGES
    ) {
      break;
    }
    const previous = treeSignature(nodes);
    await driver.swipeWorkspaceToNextPage(bounds);
    // Allow the swipe animation to start before asking for two matching captures.
    await driver.timer.sleep(LAUNCHER_SETTLE_POLL_MS);
    nodes = await waitForQuietLauncher(driver, signal);
    if (treeSignature(nodes) === previous) {
      break;
    }
  }
  return false;
}

/**
 * Checks following workspace pages before restarting a known launcher at most once, then
 * scans again from the launcher's reset page. In-process prototype saves share ownership;
 * a concurrent save can scan but cannot restart underneath the owner.
 */
export async function refreshLauncherForShortcut(
  driver: LauncherRefreshDriver,
  options: { label: string; signal?: AbortSignal },
): Promise<LauncherRefreshOutcome> {
  const release = driver.gate.tryAcquire(driver.deviceKey);
  try {
    const first = await driver.capture.capture({ freshness: "fresh", signal: options.signal });
    if (await scanWorkspace(driver, first.nodes, options.label, options.signal)) {
      return { launcherRestarted: false, shortcutVisible: true };
    }
    if (!release) {
      return {
        launcherRestarted: false,
        shortcutVisible: false,
        message: `The shortcut "${options.label}" is not visible; another prototype save is already refreshing the home screen on this device (${driver.deviceKey}).`,
      };
    }
    return await restartAndScan(driver, options);
  } finally {
    release?.();
  }
}

async function restartAndScan(
  driver: LauncherRefreshDriver,
  { label, signal }: { label: string; signal?: AbortSignal },
): Promise<LauncherRefreshOutcome> {
  const launcher = await driver.resolveLauncher();
  if (launcher === null || !KNOWN_ANDROID_LAUNCHER_PACKAGES.includes(launcher)) {
    return {
      launcherRestarted: false,
      shortcutVisible: false,
      message: `The shortcut "${label}" is not visible and the default launcher (${launcher ?? "unresolved"}) is not a known launcher, so it was not restarted; go to the home screen or restart the launcher yourself.`,
    };
  }
  signal?.throwIfAborted();
  try {
    await driver.restartLauncher(launcher);
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`[prototype] launcher restart failed: ${errorMessage(error)}`, error);
    return {
      launcherRestarted: false,
      shortcutVisible: false,
      message: `The shortcut "${label}" is not visible and restarting ${launcher} failed (${errorMessage(error)}).`,
    };
  }
  const settled = await waitForQuietLauncher(driver, signal);
  const visible = await scanWorkspace(driver, settled, label, signal);
  return {
    launcherRestarted: true,
    shortcutVisible: visible,
    ...(visible
      ? {}
      : {
          message: `Restarted ${launcher}, but the shortcut "${label}" is still not visible after scanning all home screen pages (up to ${MAX_WORKSPACE_PAGES}); the launcher may have rejected it.`,
        }),
  };
}
