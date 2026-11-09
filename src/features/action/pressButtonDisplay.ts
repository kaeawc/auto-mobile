import { ActionableError, type BootedDevice } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { resolveActionDisplayId } from "./TargetDisplayAction";

/** Resolves a `display` argument to an Android logical display id (#17643). */
export type PressButtonDisplayResolver = (
  display: string,
  signal: AbortSignal | undefined,
) => Promise<number | undefined>;

/**
 * The Android logical display a pressButton `display` argument names. Undefined (no `display`) and 0
 * (the default display) both keep the default key routing. Other platforms refuse a `display`.
 */
export async function pressButtonDisplayId(
  device: BootedDevice,
  display: string | undefined,
  {
    adb,
    resolver,
    signal,
  }: { adb: AdbCommandRunner; resolver?: PressButtonDisplayResolver; signal?: AbortSignal },
): Promise<number | undefined> {
  if (display === undefined) {
    return undefined;
  }
  if (device.platform !== "android") {
    throw new ActionableError(
      `pressButton display applies to Android only; omit display on ${device.platform}.`,
    );
  }
  const id = await (resolver
    ? resolver(display, signal)
    : resolveActionDisplayId(device, display, { adb, signal }));
  return id === 0 ? undefined : id;
}

/** `adb shell input ...` argv routed to a logical display with `-d`. */
export function inputOnDisplay(argv: string[], displayId: number | undefined): string[] {
  return displayId === undefined
    ? argv
    : [...argv.slice(0, 2), "-d", String(displayId), ...argv.slice(2)];
}
