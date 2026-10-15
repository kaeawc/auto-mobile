const toolFailures = new WeakSet<object>();

/** Keep failure status out of the wire envelope, including shallow copies sharing content. */
export function markToolFailure<T extends object>(response: T): T {
  toolFailures.add(response);
  const content = (response as { content?: unknown }).content;
  if (Array.isArray(content)) {
    toolFailures.add(content);
  }
  return response;
}

export function isMarkedToolFailure(response: unknown): boolean {
  if (response === null || typeof response !== "object") {
    return false;
  }
  const content = (response as { content?: unknown }).content;
  return toolFailures.has(response) || (Array.isArray(content) && toolFailures.has(content));
}

/**
 * Preserve the out-of-band signal when rebuilding a response's content array.
 * Defensive: today's rebuild sites run after the registry has classified the
 * result, but a rebuilt `content` would otherwise silently drop the mark.
 */
export function carryToolFailureMark<T extends object>(from: unknown, to: T): T {
  return isMarkedToolFailure(from) ? markToolFailure(to) : to;
}
