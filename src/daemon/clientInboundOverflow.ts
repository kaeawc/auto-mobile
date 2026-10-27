import { logger } from "../utils/logger";

/** Locate a quoted key/id's end; JSON.parse validates its escapes and contents. */
function overflowStringEnd(prefix: string, start: number): number {
  for (let index = start + 1; index < prefix.length; index++) {
    if (prefix[index] === "\\") {
      index++;
    } else if (prefix[index] === '"') {
      return index;
    }
  }
  return -1;
}

/**
 * Owner request id of an oversized frame, null for a positively unrelated frame,
 * undefined for an unreadable head.
 */
export function overflowingResponseId(
  head: Buffer | undefined,
  isPending: (requestId: string) => boolean,
): string | null | undefined {
  const prefix = head?.toString("utf8");
  if (!prefix?.startsWith('{"')) {
    return undefined;
  }
  try {
    const keyEnd = overflowStringEnd(prefix, 1);
    const key: unknown = JSON.parse(prefix.slice(1, keyEnd + 1));
    if (key !== "id") {
      return null;
    }
    if (!prefix.slice(keyEnd + 1).startsWith(':"')) {
      return undefined;
    }
    const idStart = keyEnd + 2;
    const idEnd = overflowStringEnd(prefix, idStart);
    const id: string = JSON.parse(prefix.slice(idStart, idEnd + 1));
    return isPending(id) ? id : null;
  } catch {
    // An incomplete or invalid id is expected in a bounded head; attribute nothing.
    logger.debug("Oversized daemon frame head contained no complete response id");
    return undefined;
  }
}
