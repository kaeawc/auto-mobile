import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { textOrDescription, type SearchableEntry } from "../utility/SearchableNode";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { resolveConfiguredHomePackage } from "../observe/androidLauncherPackages";
import type { LauncherRefreshDriver } from "./launcherRefresh";
import { InMemoryLauncherRefreshGate } from "./LauncherRefreshGate";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/** Labels that only ever name the launcher's pin dialog accept control (Pixel/Launcher3 text). */
const UNAMBIGUOUS_ACCEPT = new Set(["add to home screen", "add automatically"]);
/** A bare "Add" is accepted only beside a "Cancel", i.e. when it is clearly a dialog button. */
const BARE_ACCEPT = "add";
const CANCEL_LABELS = new Set(["cancel", "don't add", "dont add", "no thanks"]);

export const PIN_CONFIRM_POLL_MS = 250;
export const PIN_CONFIRM_TIMEOUT_MS = 5000;

export type PinConfirmationOutcome =
  | { status: "tapped"; label: string }
  | { status: "unrecognized"; visibleButtons: string[] }
  | { status: "timeout" }
  | { status: "tap_failed"; error: string };

export interface PinConfirmationDriver {
  capture: HierarchyCapture;
  /** Taps a screen pixel; throws when the tap could not be delivered. */
  tapAt(x: number, y: number): Promise<void>;
  timer: Timer;
}

export type PinConfirmButton =
  | { kind: "found"; label: string; x: number; y: number }
  | { kind: "unrecognized"; visibleButtons: string[] }
  | { kind: "absent" };

function labelOf(entry: SearchableEntry): string {
  return textOrDescription(entry).trim();
}

/**
 * Finds the launcher pin dialog's accept button in a captured hierarchy. Matching is by label
 * (the resource ids of OEM launchers are not captured, so none are guessed) and never selects a
 * cancel control. The API 37 Pixel Launcher dialog is Compose: its "Cancel" and "Add to home
 * screen" nodes are plain text with no click action (the handler sits on an unreported ancestor),
 * so any labelled node with bounds qualifies, and an actionable match is preferred over a
 * non-actionable one. A dialog with a cancel button but no recognizable accept is `unrecognized`.
 */
export function findPinConfirmButton(nodes: readonly SearchableEntry[]): PinConfirmButton {
  const labelled = nodes
    .filter((entry) => entry.bounds !== undefined && labelOf(entry) !== "")
    .map((entry) => ({ entry, label: labelOf(entry).toLowerCase() }));
  const hasCancel = labelled.some(({ label }) => CANCEL_LABELS.has(label));
  const matches = labelled.filter(
    ({ label }) => UNAMBIGUOUS_ACCEPT.has(label) || (hasCancel && label === BARE_ACCEPT),
  );
  const accept = matches.find(({ entry }) => entry.actionable) ?? matches[0];
  const bounds = accept?.entry.bounds;
  if (accept && bounds) {
    return {
      kind: "found",
      label: labelOf(accept.entry),
      x: Math.round((bounds.left + bounds.right) / 2),
      y: Math.round((bounds.top + bounds.bottom) / 2),
    };
  }
  return hasCancel
    ? { kind: "unrecognized", visibleButtons: labelled.map(({ entry }) => labelOf(entry)) }
    : { kind: "absent" };
}

/** Waits (bounded, on the injected timer) for the pin dialog and taps its accept button once. */
export async function confirmPinDialog(
  driver: PinConfirmationDriver,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<PinConfirmationOutcome> {
  const timeoutMs = options.timeoutMs ?? PIN_CONFIRM_TIMEOUT_MS;
  const pollMs = options.pollMs ?? PIN_CONFIRM_POLL_MS;
  const deadline = driver.timer.now() + timeoutMs;
  while (true) {
    options.signal?.throwIfAborted();
    const snapshot = await driver.capture.capture({ freshness: "fresh", signal: options.signal });
    const found = findPinConfirmButton(snapshot.nodes);
    if (found.kind === "found") {
      try {
        await driver.tapAt(found.x, found.y);
      } catch (error) {
        logger.warn(`[prototype] pin dialog tap failed: ${errorMessage(error)}`, error);
        return { status: "tap_failed", error: errorMessage(error) };
      }
      return { status: "tapped", label: found.label };
    }
    if (found.kind === "unrecognized") {
      return { status: "unrecognized", visibleButtons: found.visibleButtons };
    }
    if (driver.timer.now() + pollMs > deadline) {
      return { status: "timeout" };
    }
    await driver.timer.sleep(pollMs);
  }
}

const launcherRefreshGate = new InMemoryLauncherRefreshGate();

/** Host adb for the saved actions plus the pin-dialog driver that taps through that same adb. */
export function savedAdbDependencies(
  device: BootedDevice,
  dependencies: {
    adbFactory?: AdbClientFactory;
    anchorHierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
    timer?: Timer;
  },
): {
  adb: AdbExecutor;
  pinConfirmation: PinConfirmationDriver;
  launcherRefresh: LauncherRefreshDriver;
} {
  const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
  const capture = (dependencies.anchorHierarchyCaptureFactory ?? createDeviceHierarchyCapture)(
    device,
  );
  const timer = dependencies.timer ?? defaultTimer;
  return {
    adb,
    pinConfirmation: {
      capture,
      timer,
      tapAt: async (x, y) => {
        await adb.executeCommand(`shell input tap ${x} ${y}`);
      },
    },
    launcherRefresh: {
      deviceKey: device.deviceId,
      gate: launcherRefreshGate,
      swipeWorkspaceToNextPage: async (bounds) => {
        const width = bounds.right - bounds.left;
        const y = Math.round((bounds.top + bounds.bottom) / 2);
        const startX = Math.round(bounds.left + width * 0.8);
        const endX = Math.round(bounds.left + width * 0.2);
        await adb.executeCommand(`shell input swipe ${startX} ${y} ${endX} ${y} 300`, {
          noRetry: true,
        });
      },
      capture,
      timer,
      resolveLauncher: () => resolveConfiguredHomePackage(adb, device.deviceId, timer),
      restartLauncher: async (launcherPackage) => {
        await adb.executeCommand(`shell am force-stop ${launcherPackage}`, { noRetry: true });
        await adb.executeCommand(
          "shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME",
          { noRetry: true },
        );
      },
    },
  };
}
