import type { BootedDevice, KeyboardResult } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";

export interface SendKeysKeyboardCloser {
  close(signal?: AbortSignal): Promise<KeyboardResult>;
}

export async function dismissKeyboardAfterSendKeys(
  device: BootedDevice,
  enabled: boolean,
  succeeded: boolean,
  close: (signal?: AbortSignal) => Promise<KeyboardResult>,
  signal?: AbortSignal,
): Promise<{ keyboardDismissed?: boolean; warnings?: string[] }> {
  if (!enabled || !succeeded || device.platform !== "android") {
    return {};
  }
  try {
    const result = await close(signal);
    if (result.success) {
      return { keyboardDismissed: true };
    }
    const warning = `keyboard dismissal failed: ${result.error ?? result.message}`;
    return { keyboardDismissed: false, warnings: [warning] };
  } catch (error) {
    const warning = `keyboard dismissal failed: ${errorMessage(error)}`;
    return { keyboardDismissed: false, warnings: [warning] };
  }
}
