import type { AndroidModeTyper, AndroidModeTypeRequest } from "./AndroidModeTyper";
import type { SendKeysTextClient, TextActionResult } from "../SendKeys";

export interface A11yTyperHost {
  replace: SendKeysTextClient["replace"];
  insertText(text: string, signal?: AbortSignal): Promise<TextActionResult>;
}

export class A11yTyper implements AndroidModeTyper {
  constructor(private readonly host: A11yTyperHost) {}

  type({ text, operation, signal }: AndroidModeTypeRequest): Promise<TextActionResult> {
    return operation === "replace" ? this.host.replace(text) : this.host.insertText(text, signal);
  }
}
