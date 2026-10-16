import type { KeyboardProfileId } from "../keyboardProfiles";
import type { ImeCommitRouting, AndroidTypeOptions } from "./ImeTypes";
import type { SendKeysOperation, TextActionResult } from "../SendKeys";

export interface AndroidModeTypeRequest {
  text: string;
  operation: SendKeysOperation;
  signal?: AbortSignal;
  display?: string;
  focusedInputVerified?: boolean;
  keyboardProfile?: KeyboardProfileId;
  autoImeFallback?: AndroidTypeOptions["autoImeFallback"];
  routing?: ImeCommitRouting;
  mode?: "ime" | "imeKeyEvents";
}

export interface AndroidModeTyper {
  type(request: AndroidModeTypeRequest): Promise<TextActionResult>;
}
