import type { BootedDevice, DisplayPanel } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { ProcessExitState } from "../../utils/ChildProcessTracker";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { logger } from "../../utils/logger";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import { resolveTargetDisplay } from "../observe/DisplaySelection";
import { displayTransitions } from "../observe/DisplayTransition";

export interface RecordingPanel {
  key: string;
  role: DisplayPanel["role"];
}

export interface AndroidRecordingDisplay {
  panel: RecordingPanel;
  physicalId?: string;
  activePanel: RecordingPanel;
  warning?: string;
}

/** A short failed screenrecord launch may prove the optional flag is unsupported. */
export function rejectedScreenrecordDisplayFlag(
  exitCode: number | null | undefined,
  stderr: string[],
): boolean {
  return (
    exitCode !== undefined &&
    exitCode !== null &&
    exitCode !== 0 &&
    /usage|unknown (?:option|argument)|unrecognized (?:option|argument)/i.test(stderr.join(""))
  );
}

/** Bound capability detection so a healthy long-lived capture can start promptly. */
export async function probeScreenrecordDisplayFlag(
  tracker: { exitPromise: Promise<void>; exitState: ProcessExitState; stderr: string[] },
  timer: Timer,
  timeoutMs = 20,
): Promise<boolean> {
  const probeTimeout = new Error("screenrecord display flag probe timed out");
  try {
    await raceWithDeadline(tracker.exitPromise, {
      timer,
      timeoutMs,
      label: "screenrecord display flag probe",
      timeoutError: () => probeTimeout,
    });
  } catch (error) {
    if (error !== probeTimeout) {
      throw toActionableError(error, "Android screenrecord startup failed");
    }
    // A running capture is the expected outcome of this bounded capability probe.
    logger.debug("[VideoCapture] screenrecord display flag probe found a live capture");
  }
  return rejectedScreenrecordDisplayFlag(tracker.exitState.exitCode, tracker.stderr);
}

function resolveOnOldApi(device: BootedDevice, request?: string): AndroidRecordingDisplay {
  if (request !== undefined && request !== "active") {
    throw new ActionableError("Recording a selected Android panel requires API 34 or newer.");
  }
  const selected = resolveTargetDisplay(device.displays, "active", {});
  const panel = { key: selected.key, role: selected.role };
  return {
    panel,
    activePanel: panel,
    warning: "Android API below 34: recording the default display without a pinned panel.",
  };
}

function resolveWithoutMultiplePanels(
  device: BootedDevice,
  request?: string,
): AndroidRecordingDisplay | undefined {
  if (!device.displays?.panels.length) {
    if (request !== undefined && request !== "active") {
      resolveTargetDisplay(device.displays, request, {});
    }
    return undefined;
  }
  const selected = resolveTargetDisplay(device.displays, request, {});
  const panel = { key: selected.key, role: selected.role };
  return { panel, activePanel: panel };
}

/** Resolve at capture start; Android screenrecord accepts a physical ID, not a logical ID. */
export async function resolveAndroidRecordingDisplay(
  device: BootedDevice,
  adb: Pick<AdbExecutor, "executeCommand">,
  request?: string,
  signal?: AbortSignal,
  timer: Pick<Timer, "now"> = defaultTimer,
): Promise<AndroidRecordingDisplay | undefined> {
  if ((device.displays?.panels.length ?? 0) < 2) {
    return resolveWithoutMultiplePanels(device, request);
  }
  if (device.apiLevel !== undefined && device.apiLevel < 34) {
    return resolveOnOldApi(device, request);
  }
  const observed = await new ObservedAndroidDisplayCache(timer).resolve(device, adb, signal, true);
  const stamped = displayTransitions.observedPanel(device.deviceId);
  const active =
    stamped && device.displays?.panels.some((panel) => panel.key === stamped.key)
      ? stamped
      : observed.display;
  const selected = resolveTargetDisplay(device.displays, request, {
    focusedPanelKey: active.key,
    activePanelKey: observed.display.key,
    posture: observed.display.posture,
  });
  if (!/^(0|[1-9]\d*)$/.test(selected.key)) {
    throw new ActionableError(
      `Display panel "${selected.key}" has no physical Android display ID.`,
    );
  }
  return {
    panel: { key: selected.key, role: selected.role },
    physicalId: selected.key,
    activePanel: { key: active.key, role: active.role },
  };
}
