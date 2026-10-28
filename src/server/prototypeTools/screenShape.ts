import { AdbScreenRoundReader, type ScreenRoundReader } from "../../features/wear/screenRound";
import type { BootedDevice } from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";

/** Builds the round-display reader for one device; tests inject a fake. */
export type ScreenRoundReaderFactory = (device: BootedDevice) => ScreenRoundReader;

/**
 * `screenRound` for a successful show on a Wear OS device (#14907), so an agent can tell why
 * corner content is clipped. Gated like `observe`'s `isScreenRound`: other devices pay no read
 * and report no field, and an unreadable display leaves it absent.
 */
export async function prototypeScreenShapeOutput(
  input: { action: string; success: boolean; device: BootedDevice; signal?: AbortSignal },
  deps: { screenRoundFactory?: ScreenRoundReaderFactory; adbFactory?: AdbClientFactory },
): Promise<{ screenRound?: boolean }> {
  const { action, success, device, signal } = input;
  if (action !== "show" || !success || device.platform !== "android") {
    return {};
  }
  if (device.formFactor !== "watch") {
    return {};
  }
  const reader =
    deps.screenRoundFactory?.(device) ??
    new AdbScreenRoundReader((deps.adbFactory ?? defaultAdbClientFactory).create(device));
  const round = await reader.isScreenRound(signal);
  return round === undefined ? {} : { screenRound: round };
}
