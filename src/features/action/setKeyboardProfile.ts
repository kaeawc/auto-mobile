import { ActionableError, type BootedDevice } from "../../models";
import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../observe/android";
import { throwIfAborted } from "../../utils/toolUtils";
import { withAndroidImeLock } from "./androidImeLock";
import { KEYBOARD_PROFILE_IDS, type KeyboardProfileId } from "./keyboardProfiles";

/**
 * Switch the AutoMobile IME's keyboard behaviour profile on an Android device. Shared by the
 * `keyboard` tool, the manufacturer-profile executors and the daemon's release cleanup, which
 * cannot reach the server tier.
 */
export async function setKeyboardProfile(
  device: BootedDevice,
  profile: KeyboardProfileId | undefined,
  client?: Pick<AndroidCtrlProxy, "supportsCommand" | "setKeyboardProfile">,
  signal?: AbortSignal,
): Promise<{ activeProfileId?: string; previousProfileId?: string }> {
  if (!profile) {
    throw new ActionableError(
      `keyboard setProfile requires profile: ${KEYBOARD_PROFILE_IDS.join(", ")}.`,
    );
  }
  if (device.platform !== "android") {
    throw new ActionableError("Keyboard profiles are Android-only; select an Android device.");
  }
  const profileClient = client ?? AndroidCtrlProxyClient.getInstance(device);
  const supported = await profileClient.supportsCommand("request_set_keyboard_profile");
  throwIfAborted(signal);
  if (!supported) {
    throw new ActionableError(
      "The installed control-proxy build does not support keyboard profiles; update/re-cut the APK.",
    );
  }
  const result = await withAndroidImeLock(
    device.deviceId,
    () => {
      throwIfAborted(signal);
      return profileClient.setKeyboardProfile(profile);
    },
    signal,
  );
  if (!result.success) {
    throw new ActionableError(result.error ?? "Failed to set keyboard profile.");
  }
  return { activeProfileId: result.activeProfileId, previousProfileId: result.previousProfileId };
}
