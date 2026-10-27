import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { textOrDescription, type SearchableEntry } from "../utility/SearchableNode";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { KNOWN_ANDROID_LAUNCHER_PACKAGES } from "../observe/androidLauncherRegistry";

export const LAUNCHER_SETTLE_POLL_MS = 250;
export const LAUNCHER_SETTLE_TIMEOUT_MS = 5000;

/** What the host needs from the device to refresh the launcher after a shortcut change (#14887). */
export interface LauncherRefreshDriver {
  capture: HierarchyCapture;
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

/**
 * After a pin or shortcut update, makes sure the launcher shows the shortcut. Looks first and
 * never restarts when the label is already on screen; otherwise restarts the resolved default
 * launcher at most once and looks again. An unknown launcher is left alone.
 */
export async function refreshLauncherForShortcut(
  driver: LauncherRefreshDriver,
  options: { label: string; signal?: AbortSignal },
): Promise<LauncherRefreshOutcome> {
  const { label, signal } = options;
  const first = await driver.capture.capture({ freshness: "fresh", signal });
  if (isShortcutShown(first.nodes, label)) {
    return { launcherRestarted: false, shortcutVisible: true };
  }
  const launcher = await driver.resolveLauncher();
  if (launcher === null || !KNOWN_ANDROID_LAUNCHER_PACKAGES.includes(launcher)) {
    return {
      launcherRestarted: false,
      shortcutVisible: false,
      message: `The shortcut "${label}" is not visible and the default launcher (${launcher ?? "unresolved"}) is not a known launcher, so it was not restarted; go to the home screen or restart the launcher yourself.`,
    };
  }
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
  const visible = isShortcutShown(settled, label);
  return {
    launcherRestarted: true,
    shortcutVisible: visible,
    ...(visible
      ? {}
      : {
          message: `Restarted ${launcher}, but the shortcut "${label}" is still not visible; it may be on another home screen page or the launcher rejected it.`,
        }),
  };
}
