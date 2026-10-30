import { ActionableError, type BootedDevice } from "../../models";
import type { AndroidCtrlProxy } from "../observe/android";
import { androidCtrlProxyClientFor } from "../observe/android/androidCtrlProxyClientFor";
import { throwIfAborted } from "../../utils/toolUtils";
import { withAndroidImeLock } from "./androidImeLock";
import { KEYBOARD_PROFILE_IDS } from "./keyboardProfiles";

/**
 * Switch the AutoMobile IME's keyboard behaviour profile on an Android device. Shared by the
 * `keyboard` tool, the manufacturer-profile executors and the daemon's release cleanup, which
 * cannot reach the server tier. `onWritten` runs inside the IME lock, so a concurrent write
 * cannot change a restore record between the write and its recording.
 */
export async function setKeyboardProfile(
  device: BootedDevice,
  profile: string | undefined,
  {
    client,
    signal,
    onWritten,
  }: {
    client?: Pick<AndroidCtrlProxy, "supportsCommand" | "setKeyboardProfile">;
    signal?: AbortSignal;
    onWritten?: (previousProfileId: string | undefined) => void;
  } = {},
): Promise<{ activeProfileId?: string; previousProfileId?: string }> {
  if (!profile) {
    throw new ActionableError(
      `keyboard setProfile requires profile: ${KEYBOARD_PROFILE_IDS.join(", ")}.`,
    );
  }
  if (device.platform !== "android") {
    throw new ActionableError("Keyboard profiles are Android-only; select an Android device.");
  }
  const profileClient = client ?? androidCtrlProxyClientFor(device);
  const supported = await profileClient.supportsCommand("request_set_keyboard_profile");
  throwIfAborted(signal);
  if (!supported) {
    throw new ActionableError(
      "The installed control-proxy build does not support keyboard profiles; update/re-cut the APK.",
    );
  }
  const result = await withAndroidImeLock(
    device.deviceId,
    async () => {
      throwIfAborted(signal);
      const written = await profileClient.setKeyboardProfile(profile);
      if (written.success) {
        onWritten?.(written.previousProfileId);
      }
      return written;
    },
    signal,
  );
  if (!result.success) {
    throw new ActionableError(result.error ?? "Failed to set keyboard profile.");
  }
  return { activeProfileId: result.activeProfileId, previousProfileId: result.previousProfileId };
}
