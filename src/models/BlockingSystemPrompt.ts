/**
 * A window from another package (permission controller, SystemUI, framework dialog) that holds
 * focus over the app, so input meant for the app reaches it instead.
 */
export interface BlockingSystemPrompt {
  kind: "runtime-permission" | "system-dialog";
  /** Package that owns the covering window. */
  package: string;
  /** Foreground activity, when the prompt is an activity the device reported. */
  activity?: string;
}
