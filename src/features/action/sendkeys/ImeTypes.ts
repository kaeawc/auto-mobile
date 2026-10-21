import type { SendKeysOperation, ResolvedSendKeysTypingMode } from "../SendKeys";
import type { KeyboardProfileId } from "../keyboardProfiles";
type AndroidSendKeysTypingMode = Exclude<ResolvedSendKeysTypingMode, "xcuiTypeText">;
export interface ImeCommitRouting {
  focusedFieldClass?: string | null;
  /** The focused field is a password field: its typed text never reaches logs or diagnostics. */
  passwordField?: boolean;
  delivery?: "clearField";
  signal?: AbortSignal;
  display?: string;
  focusedInputVerified?: boolean;
}

export interface AndroidTypeOptions {
  text: string;
  operation: SendKeysOperation;
  mode: AndroidSendKeysTypingMode;
  keyboardProfile: KeyboardProfileId | undefined;
  autoImeFallback?: AndroidSendKeysTypingMode;
  routing?: ImeCommitRouting;
  focusedInputVerified?: boolean;
}
