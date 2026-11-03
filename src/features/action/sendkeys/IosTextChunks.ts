export const IOS_TEXT_CHUNK_CODE_POINTS = 1000;

/** Greedily pack whole graphemes; an oversized grapheme travels alone. */
export function splitIosTextChunks(text: string): string[] {
  if (Array.from(text).length <= IOS_TEXT_CHUNK_CODE_POINTS) {
    return [text];
  }
  const chunks: string[] = [];
  let chunk = "";
  let codePoints = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text,
  )) {
    const length = Array.from(segment).length;
    if (codePoints > 0 && codePoints + length > IOS_TEXT_CHUNK_CODE_POINTS) {
      chunks.push(chunk);
      chunk = "";
      codePoints = 0;
    }
    chunk += segment;
    codePoints += length;
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
}
