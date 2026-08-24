import type { BootedDevice } from "../../models";
import type { SettingsValueType } from "../observe/android/types";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";

/**
 * Result of a secure-settings write via the accessibility service.
 */
export interface SecureSettingsPutResult {
  success: boolean;
}

/**
 * Result of a secure-settings read via the accessibility service.
 */
export interface SecureSettingsGetResult {
  success: boolean;
  found: boolean;
  value?: string;
}

/**
 * Narrow seam over the CtrlProxy accessibility-service `Settings.Secure` RPC.
 *
 * TalkBackToggle only ever touches the `secure` namespace, so this interface
 * bakes that in and exposes exactly the two operations the toggle needs. It
 * exists so the a11y-first / ADB-fallback path can be unit-tested with a fake
 * instead of forcing `AndroidCtrlProxyClient.getInstance(device)` to build a
 * real `AdbClient` into the static singleton map (issue #4179).
 */
export interface SecureSettingsRpc {
  put(
    key: string,
    value: string | null,
    valueType?: SettingsValueType,
  ): Promise<SecureSettingsPutResult>;
  get(key: string): Promise<SecureSettingsGetResult>;
}

/**
 * Production adapter that resolves the live CtrlProxy client lazily (only when a
 * setting is actually written/read) and delegates to its secure-namespace RPC.
 */
export class CtrlProxySecureSettingsRpc implements SecureSettingsRpc {
  constructor(private readonly device: BootedDevice) {}

  async put(
    key: string,
    value: string | null,
    valueType?: SettingsValueType,
  ): Promise<SecureSettingsPutResult> {
    const client = AndroidCtrlProxyClient.getInstance(this.device);
    const result = await client.requestSettingsPut("secure", key, value, valueType);
    return { success: result.success };
  }

  async get(key: string): Promise<SecureSettingsGetResult> {
    const client = AndroidCtrlProxyClient.getInstance(this.device);
    const result = await client.requestSettingsGet("secure", key);
    return { success: result.success, found: result.found, value: result.value };
  }
}
