/** Parse JSON text into a value the caller must still narrow. */
export function parseJsonUnknown(text: string): unknown {
  return JSON.parse(text);
}
