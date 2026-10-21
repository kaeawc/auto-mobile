import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { throwIfAborted } from "../../utils/toolUtils";
import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../observe/android";
import { withAndroidImeLock } from "./androidImeLock";
import { KEYBOARD_PROFILE_IDS, type KeyboardProfileId } from "./keyboardProfiles";

/**
 * Set the AutoMobile IME's keyboard behaviour profile on an Android device, as
 * `keyboard setProfile`. Lives below the server tier so daemon session cleanup
 * can restore a profile with it (#14705).
 */
export async function setKeyboardProfileForTool(
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
