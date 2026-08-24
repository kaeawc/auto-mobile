import type {
  SecureSettingsRpc,
  SecureSettingsGetResult,
  SecureSettingsPutResult,
} from "../../src/features/accessibility/SecureSettingsRpc";
import type { SettingsValueType } from "../../src/features/observe/android/types";

/**
 * Fake {@link SecureSettingsRpc} for TalkBackToggle unit tests.
 *
 * Defaults to reporting the a11y-service path as unavailable (`put`/`get` return
 * `success: false`) so the toggle falls back to the injected ADB executor —
 * mirroring the real behaviour when no CtrlProxy accessibility service is
 * connected, WITHOUT building a real `AdbClient` into the static singleton map
 * (issue #4179). Tests that want to exercise the a11y-first path flip
 * {@link setPutResult}/{@link setGetResult}.
 */
export class FakeSecureSettingsRpc implements SecureSettingsRpc {
  private putResult: SecureSettingsPutResult = { success: false };
  private getResult: SecureSettingsGetResult = { success: false, found: false };

  public readonly putCalls: Array<{
    key: string;
    value: string | null;
    valueType?: SettingsValueType;
  }> = [];
  public readonly getCalls: string[] = [];

  setPutResult(result: SecureSettingsPutResult): void {
    this.putResult = result;
  }

  setGetResult(result: SecureSettingsGetResult): void {
    this.getResult = result;
  }

  async put(
    key: string,
    value: string | null,
    valueType?: SettingsValueType,
  ): Promise<SecureSettingsPutResult> {
    this.putCalls.push({ key, value, valueType });
    return this.putResult;
  }

  async get(key: string): Promise<SecureSettingsGetResult> {
    this.getCalls.push(key);
    return this.getResult;
  }
}
