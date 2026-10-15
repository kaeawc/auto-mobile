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
