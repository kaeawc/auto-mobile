import { ActionableError, type BootedDevice } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { resolveActionDisplay } from "./TargetDisplayAction";

/** A resolved pressButton display: the concrete panel key and its Android logical display id. */
export interface PressButtonDisplayTarget {
  key: string;
  displayId: number;
}

/** Resolves a `display` selector to its panel key and logical display id (#17643). */
export type PressButtonDisplayResolver = (
  display: string,
  signal: AbortSignal | undefined,
) => Promise<PressButtonDisplayTarget>;

/**
 * Resolve a pressButton `display` selector once, as tapOn does, so the key and the visual-change
 * check target the same panel. `displayId` is undefined for the default display (0), which keeps
 * the default key routing. Other platforms refuse a `display`.
 */
export async function pressButtonDisplay(
  device: BootedDevice,
  display: string | undefined,
  {
    adb,
    resolver,
    signal,
  }: { adb: AdbCommandRunner; resolver?: PressButtonDisplayResolver; signal?: AbortSignal },
): Promise<{ key?: string; displayId?: number }> {
  if (display === undefined) {
    return {};
  }
  if (device.platform !== "android") {
    throw new ActionableError(
      `pressButton display applies to Android only; omit display on ${device.platform}.`,
    );
  }
  const target = await (resolver
    ? resolver(display, signal)
    : resolveActionDisplay(device, display, { adb, signal }));
  return { key: target.key, displayId: target.displayId === 0 ? undefined : target.displayId };
}

/** The `display` of a pressButton call object; positional (progress-callback) calls have none. */
export function displayOf(call: unknown): string | undefined {
  return typeof call === "object" && call !== null && "display" in call
    ? typeof call.display === "string"
      ? call.display
      : undefined
    : undefined;
}

/** `adb shell input ...` argv routed to a logical display with `-d`. */
export function inputOnDisplay(argv: string[], displayId: number | undefined): string[] {
  return displayId === undefined
    ? argv
    : [...argv.slice(0, 2), "-d", String(displayId), ...argv.slice(2)];
}
