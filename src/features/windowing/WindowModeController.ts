import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BackStackInfo, ElementBounds, TaskInfo } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { BackStack } from "../observe/interfaces/BackStack";
import { enableFreeformSettings, restoreFreeformSettings } from "./FreeformSettings";
import {
  DESKTOP_MODE_MIN_API,
  PRESS_HOME,
  SHELL_SPLIT_MIN_API,
  SIDE_STAGE_POSITION,
  WINDOWING_MODE,
  exitSplitScreen,
  launcherStart,
  moveToDesktop,
  moveToSideStage,
  resolveLauncherActivity,
  switchSplitPosition,
  taskResize,
} from "./windowModeCommands";
import type {
  FreeformSettingKey,
  SplitPosition,
  TaskWindowState,
  WindowModeAttempt,
  WindowModeRestore,
  WindowModeResult,
  WindowModeTarget,
  WindowSettingsReceipt,
} from "./WindowModeTypes";

const COMMAND_TIMEOUT_MS = 10_000;
/** How long a call re-reads `dumpsys activity activities` for a command's effect. */
export const WINDOW_MODE_SETTLE_TIMEOUT_MS = 3_000;
const SETTLE_POLL_MS = 250;

/** Output that means a shell command did not run: `am` errors and unknown WM Shell commands. */
const COMMAND_FAILED = /^(?:Error|Exception)\b|Invalid command|Unknown command|No shell command/m;
const SPLIT_MODES = new Set(["multi-window", "split-screen-primary", "split-screen-secondary"]);

/** Puts an Android app into a window mode and reads the result back (#14115). */
export interface WindowModeController {
  setMode(request: {
    appId: string;
    mode: WindowModeTarget;
    signal?: AbortSignal;
  }): Promise<WindowModeResult>;
  restore(request: {
    appId: string;
    restore: WindowModeRestore;
    signal?: AbortSignal;
  }): Promise<WindowModeResult>;
}

export interface WindowModeControllerDeps {
  adb: AdbCommandRunner;
  backStack: BackStack;
  timer: Timer;
  deviceId: string;
}

interface Call {
  appId: string;
  signal?: AbortSignal;
  attempts: WindowModeAttempt[];
  settingsChanged: FreeformSettingKey[];
  receipt?: WindowSettingsReceipt;
}

interface Outcome {
  info: BackStackInfo;
  matched: boolean;
  method?: string;
  reason?: string;
  partnerAppId?: string;
}

/** The app's topmost task with activities: dumpsys lists tasks top to bottom. */
function appTask(info: BackStackInfo, appId: string): TaskInfo | undefined {
  return info.tasks.find(
    (task) =>
      task.packageName === appId &&
      (task.numActivities ?? 0) > 0 &&
      task.windowingMode !== undefined,
  );
}

function windowState(task: TaskInfo | undefined): TaskWindowState | undefined {
  return task?.windowingMode === undefined
    ? undefined
    : {
        taskId: task.id,
        windowingMode: task.windowingMode,
        ...(task.bounds ? { bounds: task.bounds } : {}),
      };
}

function sameBounds(a: ElementBounds | undefined, b: ElementBounds | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom
  );
}

/** Primary is the top half in portrait and the left half in landscape. */
function isPrimary(app: ElementBounds, partner: ElementBounds): boolean {
  return app.top < partner.top || (app.top === partner.top && app.left < partner.left);
}

function splitPartner(info: BackStackInfo, appId: string): TaskInfo | undefined {
  return info.tasks.find(
    (task) =>
      task.packageName !== undefined &&
      task.packageName !== appId &&
      (task.numActivities ?? 0) > 0 &&
      SPLIT_MODES.has(task.windowingMode ?? ""),
  );
}

function isFreeform(info: BackStackInfo, appId: string): boolean {
  return appTask(info, appId)?.windowingMode === "freeform";
}

function isTop(info: BackStackInfo, appId: string): boolean {
  const task = appTask(info, appId);
  return task !== undefined && info.currentActivity?.taskId === task.id;
}

/** The split-screen mode argument that puts a split app back beside its partner. */
function restoreSplitFor(
  before: BackStackInfo,
  task: TaskInfo,
  appId: string,
): WindowModeTarget | undefined {
  const partner = splitPartner(before, appId);
  if (!partner?.packageName) {
    return undefined;
  }
  const primary = task.bounds && partner.bounds ? isPrimary(task.bounds, partner.bounds) : true;
  return {
    splitScreen: { with: partner.packageName, position: primary ? "primary" : "secondary" },
  };
}

/** The mode argument that puts the app back where it was, when that can be expressed. */
function restoreModeFor(before: BackStackInfo, appId: string): WindowModeTarget | undefined {
  const task = appTask(before, appId);
  if (!task) {
    return undefined;
  }
  if (task.windowingMode === "fullscreen") {
    return "fullscreen";
  }
  if (task.windowingMode === "pinned") {
    return { pip: "enter" };
  }
  if (task.windowingMode === "freeform") {
    return { freeform: task.bounds ? { bounds: task.bounds } : {} };
  }
  return SPLIT_MODES.has(task.windowingMode ?? "")
    ? restoreSplitFor(before, task, appId)
    : undefined;
}

function windowChanged(previous: TaskWindowState, current: TaskWindowState | undefined): boolean {
  if (current?.windowingMode !== previous.windowingMode) {
    return true;
  }
  return (
    (current.bounds !== undefined || previous.bounds !== undefined) &&
    !sameBounds(current.bounds, previous.bounds)
  );
}

function partnerWindow(outcome: Outcome): WindowModeResult["partner"] {
  const appId = outcome.partnerAppId;
  const window = appId ? windowState(appTask(outcome.info, appId)) : undefined;
  return appId && window ? { appId, ...window } : undefined;
}

/** The receipt: the previous mode when the window changed, and any settings this call wrote. */
function restoreFor(
  call: Call,
  before: BackStackInfo,
  previous: TaskWindowState | undefined,
  current: TaskWindowState | undefined,
): WindowModeRestore | undefined {
  const mode =
    previous && windowChanged(previous, current) ? restoreModeFor(before, call.appId) : undefined;
  if (mode === undefined && call.receipt === undefined) {
    return undefined;
  }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(call.receipt ? { settings: call.receipt } : {}),
  };
}

export class AndroidWindowModeController implements WindowModeController {
  private readonly launcherComponents = new Map<string, string>();

  constructor(private readonly deps: WindowModeControllerDeps) {}

  async setMode(request: {
    appId: string;
    mode: WindowModeTarget;
    signal?: AbortSignal;
  }): Promise<WindowModeResult> {
    const call: Call = {
      appId: request.appId,
      signal: request.signal,
      attempts: [],
      settingsChanged: [],
    };
    const before = await this.read(call.signal);
    const outcome = await this.applyMode(call, request.mode, before);
    return this.result(call, before, outcome);
  }

  async restore(request: {
    appId: string;
    restore: WindowModeRestore;
    signal?: AbortSignal;
  }): Promise<WindowModeResult> {
    const { mode, settings } = request.restore;
    if (mode === undefined && settings === undefined) {
      throw new ActionableError("restore needs a mode, settings, or both. Nothing was changed.");
    }
    const result =
      mode === undefined
        ? await this.unchanged(request.appId, request.signal)
        : await this.setMode({ appId: request.appId, mode, signal: request.signal });
    // A restore ends the round trip, so a mode that would undo it is dropped. Settings the
    // restored mode itself turned on (restoring into freeform) keep their receipt.
    const ownSettings = result.restore?.settings;
    delete result.restore;
    if (ownSettings) {
      result.restore = { settings: ownSettings };
    }
    if (settings) {
      result.settingsRestored = await restoreFreeformSettings(
        (command) => this.shell(command, request.signal),
        this.deps.deviceId,
        settings,
      );
    }
    return result;
  }

  private async unchanged(
    appId: string,
    signal: AbortSignal | undefined,
  ): Promise<WindowModeResult> {
    const current = windowState(appTask(await this.read(signal), appId));
    return {
      appId,
      matched: true,
      ...(current ? { previous: current, current } : {}),
      attempts: [],
      settingsChanged: [],
    };
  }

  private applyMode(call: Call, mode: WindowModeTarget, before: BackStackInfo): Promise<Outcome> {
    if (mode === "fullscreen") {
      return this.fullscreen(call, before);
    }
    if ("pip" in mode) {
      return mode.pip === "enter" ? this.enterPip(call, before) : this.exitPip(call, before);
    }
    if ("freeform" in mode) {
      return this.freeform(call, before, mode.freeform.bounds);
    }
    return this.splitScreen(call, before, mode.splitScreen);
  }

  private async fullscreen(call: Call, before: BackStackInfo): Promise<Outcome> {
    const task = appTask(before, call.appId);
    if (task?.windowingMode === "fullscreen") {
      return { info: before, matched: true };
    }
    const commands = task?.windowingMode === "multi-window" ? exitSplitScreen(task.id) : [];
    commands.push(launcherStart(await this.launcher(call, call.appId), WINDOWING_MODE.fullscreen));
    const reached = await this.tryCommands(
      call,
      commands,
      (info) => appTask(info, call.appId)?.windowingMode === "fullscreen",
    );
    return {
      ...reached,
      ...(reached.matched ? {} : { reason: `${call.appId} did not return to fullscreen.` }),
    };
  }

  private async enterPip(call: Call, before: BackStackInfo): Promise<Outcome> {
    const task = this.requireTask(before, call.appId);
    if (task.windowingMode === "pinned") {
      return { info: before, matched: true };
    }
    if (!isTop(before, call.appId)) {
      // HOME only puts the resumed activity into PiP, so bring the app forward first.
      await this.tryCommands(
        call,
        [launcherStart(await this.launcher(call, call.appId), WINDOWING_MODE.fullscreen)],
        (info) => isTop(info, call.appId),
      );
    }
    const reached = await this.tryCommands(
      call,
      [PRESS_HOME],
      (info) => appTask(info, call.appId)?.windowingMode === "pinned",
    );
    return {
      ...reached,
      ...(reached.matched
        ? {}
        : {
            reason:
              `${call.appId} did not enter picture-in-picture when HOME was pressed. Its activity must ` +
              'declare android:supportsPictureInPicture="true" and enter PiP on leaving: ' +
              "setAutoEnterEnabled(true) on API 31+, or enterPictureInPictureMode() from onUserLeaveHint().",
          }),
    };
  }

  private async exitPip(call: Call, before: BackStackInfo): Promise<Outcome> {
    const pinned = (info: BackStackInfo) =>
      info.tasks.some((task) => task.packageName === call.appId && task.windowingMode === "pinned");
    if (!pinned(before)) {
      this.requireTask(before, call.appId);
      return { info: before, matched: true };
    }
    const reached = await this.tryCommands(
      call,
      [launcherStart(await this.launcher(call, call.appId), WINDOWING_MODE.fullscreen)],
      (info) => !pinned(info) && appTask(info, call.appId) !== undefined,
    );
    return {
      ...reached,
      ...(reached.matched
        ? {}
        : {
            reason: `${call.appId} is still in picture-in-picture after it was relaunched fullscreen.`,
          }),
    };
  }

  private async freeform(
    call: Call,
    before: BackStackInfo,
    bounds: ElementBounds | undefined,
  ): Promise<Outcome> {
    const settings = await enableFreeformSettings(
      (command) => this.shell(command, call.signal),
      this.deps.deviceId,
    );
    call.settingsChanged = settings.changed;
    call.receipt = settings.receipt;
    const entered = await this.enterFreeform(call, before);
    const task = appTask(entered.info, call.appId);
    if (!entered.matched || !bounds || !task || sameBounds(task.bounds, bounds)) {
      return entered;
    }
    const resized = await this.tryCommands(
      call,
      [taskResize(task.id, bounds)],
      (info) =>
        isFreeform(info, call.appId) && sameBounds(appTask(info, call.appId)?.bounds, bounds),
    );
    if (!resized.matched) {
      return {
        ...resized,
        method: entered.method,
        reason:
          "The window is freeform but its bounds were not applied as requested; the system may " +
          "clamp them to the display or the app's minimum size.",
      };
    }
    return { ...resized, method: entered.method ?? resized.method };
  }

  private async enterFreeform(call: Call, before: BackStackInfo): Promise<Outcome> {
    if (isFreeform(before, call.appId)) {
      return { info: before, matched: true };
    }
    const task = appTask(before, call.appId);
    const commands = [
      launcherStart(await this.launcher(call, call.appId), WINDOWING_MODE.freeform),
    ];
    const api = task ? await this.apiLevel(call.signal) : null;
    if (task && (api === null || api >= DESKTOP_MODE_MIN_API)) {
      commands.push(moveToDesktop(task.id));
    }
    const outcome = await this.tryCommands(call, commands, (info) => isFreeform(info, call.appId));
    return outcome.matched
      ? outcome
      : {
          ...outcome,
          reason:
            `${call.appId} did not enter freeform. The image may not support freeform windows ` +
            "(config_freeformWindowManagement), or need desktop windowing enabled in developer options and a reboot.",
        };
  }

  private async splitScreen(
    call: Call,
    before: BackStackInfo,
    spec: { with?: string; position?: SplitPosition },
  ): Promise<Outcome> {
    if (spec.with === call.appId) {
      throw new ActionableError("splitScreen.with must name a different app than appId.");
    }
    const position = spec.position ?? "primary";
    const api = await this.apiLevel(call.signal);
    return api !== null && api < SHELL_SPLIT_MIN_API
      ? this.legacySplit(call, position, spec.with)
      : this.shellSplit(call, before, position, spec.with);
  }

  /** API 31 and below: dock one task as primary; the next launch fills the secondary side. */
  private async legacySplit(
    call: Call,
    position: SplitPosition,
    partner: string | undefined,
  ): Promise<Outcome> {
    const [primary, secondary] =
      position === "primary" ? [call.appId, partner] : [partner, call.appId];
    if (primary === undefined) {
      throw new ActionableError(
        'position "secondary" needs splitScreen.with: the app to dock on the primary side.',
      );
    }
    const docked = await this.tryCommands(
      call,
      [launcherStart(await this.launcher(call, primary), WINDOWING_MODE.splitScreenPrimary)],
      (info) => appTask(info, primary)?.windowingMode === "split-screen-primary",
    );
    if (!docked.matched || secondary === undefined) {
      return {
        ...docked,
        ...(partner ? { partnerAppId: partner } : {}),
        ...(docked.matched
          ? {}
          : { reason: `${primary} could not be docked as split-screen primary.` }),
      };
    }
    const filled = await this.tryCommands(
      call,
      [launcherStart(await this.launcher(call, secondary), WINDOWING_MODE.splitScreenSecondary)],
      (info) => appTask(info, secondary)?.windowingMode === "split-screen-secondary",
    );
    return {
      ...filled,
      method: position === "primary" ? docked.method : filled.method,
      partnerAppId: partner!,
      ...(filled.matched
        ? {}
        : { reason: `${secondary} did not open in the split-screen secondary side.` }),
    };
  }

  /** API 32+: the WM Shell moves `with` into the side stage; the app, on top, becomes the main stage. */
  private async shellSplit(
    call: Call,
    before: BackStackInfo,
    position: SplitPosition,
    partner: string | undefined,
  ): Promise<Outcome> {
    if (partner === undefined) {
      throw new ActionableError(
        "splitScreen.with is required on API 32+: the system splits two running apps. Name the second app's package.",
      );
    }
    const split = (info: BackStackInfo) =>
      appTask(info, call.appId)?.windowingMode === "multi-window" &&
      appTask(info, partner)?.windowingMode === "multi-window";
    const onSide = (info: BackStackInfo) => {
      const app = appTask(info, call.appId)?.bounds;
      const other = appTask(info, partner)?.bounds;
      return !app || !other || isPrimary(app, other) === (position === "primary");
    };
    let outcome: Outcome = { info: before, matched: split(before) };
    if (!outcome.matched) {
      outcome = await this.enterShellSplit(call, before, position, partner, split);
      if (!outcome.matched) {
        return { ...outcome, partnerAppId: partner };
      }
    }
    if (!onSide(outcome.info)) {
      const switched = await this.tryCommands(
        call,
        switchSplitPosition(),
        (info) => split(info) && onSide(info),
      );
      return {
        ...switched,
        method: outcome.method,
        partnerAppId: partner,
        ...(switched.matched
          ? {}
          : { reason: `${call.appId} is split but not on the ${position} side.` }),
      };
    }
    return { ...outcome, partnerAppId: partner };
  }

  private async enterShellSplit(
    call: Call,
    before: BackStackInfo,
    position: SplitPosition,
    partner: string,
    split: (info: BackStackInfo) => boolean,
  ): Promise<Outcome> {
    let info = before;
    if (!appTask(info, partner)) {
      info = (
        await this.tryCommands(
          call,
          [launcherStart(await this.launcher(call, partner), WINDOWING_MODE.fullscreen)],
          (next) => appTask(next, partner) !== undefined,
        )
      ).info;
    }
    if (!isTop(info, call.appId)) {
      info = (
        await this.tryCommands(
          call,
          [launcherStart(await this.launcher(call, call.appId), WINDOWING_MODE.fullscreen)],
          (next) => isTop(next, call.appId),
        )
      ).info;
    }
    const partnerTask = appTask(info, partner);
    if (!partnerTask) {
      return { info, matched: false, reason: `${partner} has no task to put in split screen.` };
    }
    const sideStage =
      position === "primary" ? SIDE_STAGE_POSITION.bottomOrRight : SIDE_STAGE_POSITION.topOrLeft;
    const entered = await this.tryCommands(call, moveToSideStage(partnerTask.id, sideStage), split);
    return {
      ...entered,
      ...(entered.matched
        ? {}
        : { reason: `The system did not put ${call.appId} and ${partner} into split screen.` }),
    };
  }

  /** Runs each candidate until a read-back satisfies `reached`; records every attempt. */
  private async tryCommands(
    call: Call,
    commands: string[],
    reached: (info: BackStackInfo) => boolean,
  ): Promise<Outcome> {
    let info: BackStackInfo | undefined;
    for (const command of commands) {
      try {
        const output = await this.shell(command, call.signal);
        if (COMMAND_FAILED.test(output)) {
          call.attempts.push({ command, outcome: "failed", error: output.slice(0, 300) });
          continue;
        }
      } catch (error) {
        call.signal?.throwIfAborted();
        // A release without this command rejects it; the next candidate may still work.
        logger.debug(`windowMode candidate failed: ${command}: ${errorMessage(error)}`);
        call.attempts.push({ command, outcome: "failed", error: errorMessage(error) });
        continue;
      }
      info = await this.settle(reached, call.signal);
      if (reached(info)) {
        call.attempts.push({ command, outcome: "reached" });
        return { info, matched: true, method: command };
      }
      call.attempts.push({ command, outcome: "not_reached" });
    }
    return { info: info ?? (await this.read(call.signal)), matched: false };
  }

  private async settle(
    reached: (info: BackStackInfo) => boolean,
    signal: AbortSignal | undefined,
  ): Promise<BackStackInfo> {
    const deadline = this.deps.timer.now() + WINDOW_MODE_SETTLE_TIMEOUT_MS;
    while (true) {
      const info = await this.read(signal);
      if (reached(info) || this.deps.timer.now() >= deadline) {
        return info;
      }
      await this.deps.timer.sleep(SETTLE_POLL_MS);
    }
  }

  private async read(signal: AbortSignal | undefined): Promise<BackStackInfo> {
    signal?.throwIfAborted();
    const info = await this.deps.backStack.execute(undefined, signal);
    signal?.throwIfAborted();
    if (info.partial) {
      throw new ActionableError(
        "Could not read tasks from dumpsys activity activities, so the window mode cannot be read back.",
      );
    }
    return info;
  }

  private requireTask(info: BackStackInfo, appId: string): TaskInfo {
    const task = appTask(info, appId);
    if (!task) {
      throw new ActionableError(`${appId} has no running task. Launch it first (launchApp).`);
    }
    return task;
  }

  private async launcher(call: Call, appId: string): Promise<string> {
    const cached = this.launcherComponents.get(appId);
    if (cached) {
      return cached;
    }
    const output = await this.shell(resolveLauncherActivity(appId), call.signal);
    const component = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^[\w.]+\/[\w.$]+$/.test(line));
    if (!component) {
      throw new ActionableError(
        `${appId} has no launcher activity (is it installed?), so it cannot be started in a window mode.`,
      );
    }
    this.launcherComponents.set(appId, component);
    return component;
  }

  private apiLevel(signal: AbortSignal | undefined): Promise<number | null> {
    return readAndroidDeviceApiLevel(this.deps.adb, COMMAND_TIMEOUT_MS, this.deps.timer, signal);
  }

  private async shell(command: string, signal: AbortSignal | undefined): Promise<string> {
    signal?.throwIfAborted();
    try {
      const result = await this.deps.adb.executeCommand(`shell ${command}`, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
      return result.stdout.trim();
    } catch (error) {
      signal?.throwIfAborted();
      throw toActionableError(error, `Failed to run adb shell ${command}`);
    }
  }

  private result(call: Call, before: BackStackInfo, outcome: Outcome): WindowModeResult {
    const previous = windowState(appTask(before, call.appId));
    const current = windowState(appTask(outcome.info, call.appId));
    const partner = partnerWindow(outcome);
    const restore = restoreFor(call, before, previous, current);
    return {
      appId: call.appId,
      matched: outcome.matched,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(previous ? { previous } : {}),
      ...(current ? { current } : {}),
      ...(partner ? { partner } : {}),
      ...(outcome.method ? { method: outcome.method } : {}),
      attempts: call.attempts,
      settingsChanged: call.settingsChanged,
      ...(restore ? { restore } : {}),
    };
  }
}
