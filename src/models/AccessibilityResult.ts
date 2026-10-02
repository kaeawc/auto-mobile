export interface TalkBackBlockingPrompt {
  kind: "runtime-permission";
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

export interface VoiceOverResult {
  supported: boolean;
  applied: boolean;
  reason?: string;
  currentState?: boolean;
}
