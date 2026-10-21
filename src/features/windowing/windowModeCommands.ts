import type { ElementBounds } from "../../models";
import { shellQuote } from "../../utils/shellQuote";

/**
 * Device-shell commands `windowMode` runs (#14115). Every one is a candidate: the controller
 * reads `dumpsys activity activities` back after each and stops at the first that reached the
 * requested state, so a command a release lacks costs one attempt, not a wrong answer. See
 * docs/design-docs/plat/android/windowing.md for the per-API-level reasoning; none of these
 * has been verified on an emulator yet.
 */

/** `WindowConfiguration.WINDOWING_MODE_*` values `am start --windowingMode` takes. */
export const WINDOWING_MODE = {
  fullscreen: 1,
  splitScreenPrimary: 3,
  splitScreenSecondary: 4,
  freeform: 5,
} as const;

/** `SplitScreenConstants.SPLIT_POSITION_*`: the side stage's position. */
export const SIDE_STAGE_POSITION = { topOrLeft: 0, bottomOrRight: 1 } as const;

/** NEW_TASK | RESET_TASK_IF_NEEDED: the flags a launcher icon tap uses, so a running task is brought forward, not stacked. */
const LAUNCHER_FLAGS = "0x10200000";

/** The first API level whose split screen is the WM Shell's (12L); earlier levels use legacy docked split. */
export const SHELL_SPLIT_MIN_API = 32;
/** The first API level with WM Shell desktop windowing commands. */
export const DESKTOP_MODE_MIN_API = 35;

/** Starts the app the way its launcher icon does, into a windowing mode; reuses a running task. */
export function launcherStart(component: string, windowingMode: number): string {
  return (
    `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ` +
    `-f ${LAUNCHER_FLAGS} -n ${shellQuote(component)} --windowingMode ${windowingMode}`
  );
}

export function resolveLauncherActivity(appId: string): string {
  return `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${shellQuote(appId)}`;
}

/** `ActivityManagerShellCommand.runTaskResize` reads four separate bound arguments. */
export function taskResize(taskId: number, bounds: ElementBounds): string {
  return `am task resize ${taskId} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`;
}

export const PRESS_HOME = "input keyevent KEYCODE_HOME";

const WM_SHELL = "dumpsys activity service SystemUIService WMShell";

/**
 * A WM Shell command in both registrations: Android 14+ prefixes it with its module name
 * (`splitscreen moveToSideStage ...`); 12L and 13 accept it bare.
 */
function wmShell(module: string, command: string): string[] {
  return [`${WM_SHELL} ${module} ${command}`, `${WM_SHELL} ${command}`];
}

export function moveToSideStage(taskId: number, position: number): string[] {
  return wmShell("splitscreen", `moveToSideStage ${taskId} ${position}`);
}

export function switchSplitPosition(): string[] {
  return wmShell("splitscreen", "switchSplitPosition");
}

export function exitSplitScreen(taskId: number): string[] {
  return wmShell("splitscreen", `exitSplitScreen ${taskId}`);
}

export function moveToDesktop(taskId: number): string {
  return `${WM_SHELL} desktopmode moveToDesktop ${taskId}`;
}

export function readGlobalSetting(key: string): string {
  return `settings get global ${key}`;
}

export function writeGlobalSetting(key: string, value: string | null): string {
  return value === null
    ? `settings delete global ${key}`
    : `settings put global ${key} ${shellQuote(value)}`;
}

export const READ_BOOT_ID = "cat /proc/sys/kernel/random/boot_id";
