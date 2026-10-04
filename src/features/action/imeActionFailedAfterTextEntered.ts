/** Shared guidance when typing succeeded but the following IME action failed. */
export function imeActionFailedAfterTextEntered(imeAction: string, reason: string): string {
  return `IME action '${imeAction}' failed after the text was entered: ${reason}. Do not retype the text.`;
}
