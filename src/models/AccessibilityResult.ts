/**
 * A system window covering the screen after TalkBack was enabled: a runtime permission prompt, or
 * a SystemUI or framework (`android`) dialog activity.
 */
export interface TalkBackBlockingPrompt {
  kind: "runtime-permission" | "system-dialog";
  package: string;
  activity: string;
}

export interface TalkBackResult {
  supported: boolean;
  applied: boolean;
  reason?: string;
  currentState?: boolean;
  warning?: string;
  blockingPrompt?: TalkBackBlockingPrompt;
}

/** Hooks a caller can pass to a screen-reader toggle (TalkBack or VoiceOver). */
export interface ScreenReaderToggleOptions {
  /**
   * Called after the toggle has read the screen reader's state and found that it
   * differs from the requested one, but before anything is written. A session
   * records `previousEnabled` here so a failure part-way through the write is
   * still restored on release (#10146).
   */
  beforeChange?: (previousEnabled: boolean) => void | Promise<void>;
}

export interface VoiceOverResult {
  supported: boolean;
  applied: boolean;
  reason?: string;
  currentState?: boolean;
}
