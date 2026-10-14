import { ActionableError } from "./ActionableError";

/** Typed refusal for an SDK-provider read whose read-only enforcement is unknown (#11354). */
export const SDK_TOO_OLD_CODE = "sdk_too_old";
export const MINIMUM_READ_ONLY_SDK_VERSION = "0.0.85";

export class SdkTooOldError extends ActionableError {
  readonly code = SDK_TOO_OLD_CODE;
  readonly retryable = false;

  constructor(
    readonly appId: string,
    readonly deviceId: string,
    readonly minimumSdkVersion: string,
    cause?: unknown,
  ) {
    super(
      `${appId} on device '${deviceId}' requires AutoMobile SDK ${minimumSdkVersion} or newer ` +
        "to enforce read-only database access while another session holds the device. " +
        "Upgrade the SDK in the app or ask the holder.",
      { cause },
    );
    this.name = "SdkTooOldError";
  }

  /** The wire evidence: the device and minimum SDK version, never the holder's session. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      deviceId: this.deviceId,
      minimumSdkVersion: this.minimumSdkVersion,
      retryable: this.retryable,
    };
  }
}
