export interface IntentChooserResult {
  success: boolean;
  detected: boolean;
  action?: "always" | "just_once" | "custom";
  appSelected?: string;
  error?: string;
  observation?: any;
  /** Whether the selected chooser row carried the requested package metadata. */
  packageVerified?: boolean;
  /** Device-clock freshness floor captured immediately after a label-only chooser tap. */
  tappedAt?: number;
}
