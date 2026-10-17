import type { BootedDevice } from "../../../models";
import { isPrintableAscii } from "./AndroidTypingConstants";
import type { SendKeysKey, SendKeysSemanticKey, SendKeysTypeCommand } from "../SendKeys";

export const SEND_KEYS_SEMANTIC_KEYS = [
  "next",
  "previous",
  "done",
  "search",
  "send",
  "go",
] as const;

export function validateImeKeyEventsText(
  command: SendKeysTypeCommand,
  platform: BootedDevice["platform"],
): string | null {
  if (
    platform === "android" &&
    command.mode === "imeKeyEvents" &&
    !isPrintableAscii(command.text)
  ) {
    return "imeKeyEvents accepts printable ASCII (U+0020–U+007E) only; use mode: ime for other text.";
  }
  return null;
}

export function isSemanticKey(key: SendKeysKey): key is SendKeysSemanticKey {
  return (SEND_KEYS_SEMANTIC_KEYS as readonly string[]).includes(key);
}
