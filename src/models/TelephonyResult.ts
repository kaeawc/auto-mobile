export type PhoneCallAction = "call" | "accept" | "cancel" | "busy" | "hold";

/**
 * Machine-readable reason a phoneCall action is only partially supported.
 * `ios_simulator_callkit_limit`: the iOS Simulator's call service ends a CallKit
 * call when asked to answer or hold it, so `accept` and `hold` cannot run there.
 */
export type PhoneCallPartialReason = "ios_simulator_callkit_limit";

export interface PhoneCallResult {
  success: boolean;
  action: PhoneCallAction;
  phoneNumber?: string;
  /** `"partial"`: the platform supports the tool but not this action; see `reason`. */
  supported: boolean | "partial";
  reason?: PhoneCallPartialReason;
  message?: string;
  error?: string;
}

export interface SendSmsResult {
  success: boolean;
  phoneNumber: string;
  messageLength: number;
  supported: boolean;
  message?: string;
  error?: string;
}
