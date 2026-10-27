/** Byte cap shared by shader validation, device compile replies and upload outcomes. */
export function boundedPrototypeError(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= 2048) {
    return message;
  }
  let result = "";
  let bytes = 0;
  for (const character of message) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 2048) {
      break;
    }
    result += character;
  }
  return result;
}
