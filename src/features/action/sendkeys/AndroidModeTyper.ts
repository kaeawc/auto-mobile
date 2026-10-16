import type { SendKeysOperation, TextActionResult } from "../SendKeys";

export interface AndroidModeTypeRequest {
  text: string;
  operation: SendKeysOperation;
  signal?: AbortSignal;
  display?: string;
}

export interface AndroidModeTyper {
  type(request: AndroidModeTypeRequest): Promise<TextActionResult>;
}
