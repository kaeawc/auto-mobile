/** Stable code for a device whose recordings will contain no audio (#13627). */
export const AUDIO_INPUT_UNAVAILABLE = "audio_input_unavailable" as const;

export interface AudioInputDiagnostic {
  code: typeof AUDIO_INPUT_UNAVAILABLE;
  message: string;
  /** An environment limitation: repeating the same call cannot succeed. */
  retryable: false;
}
