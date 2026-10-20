import { ActionableError } from "../../models";

/**
 * Stable capture-startup failure for a denied macOS Screen Recording grant.
 * Socket consumers can classify this without exposing ScreenCaptureKit/TCC text
 * as their primary user guidance.
 */
export class ScreenRecordingPermissionError extends ActionableError {
  readonly approvalTarget: string;

  constructor(approvalTarget = "AutoMobile") {
    super("Screen Recording permission is required to discover and observe iOS Simulator windows.");
    this.approvalTarget = approvalTarget;
  }
}
