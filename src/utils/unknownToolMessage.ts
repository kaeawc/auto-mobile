/** Case-insensitive Levenshtein distance between two names. */
export function nameEditDistance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length];
}

const MIN_SUBSTRING_LENGTH = 4;

/**
 * Registered names close to `query`: within a length-scaled edit distance (at most 3), or a
 * case-insensitive substring of / superstring of it. Ordered by distance, then name.
 */
export function closestNames(
  query: string,
  candidates: Iterable<string>,
  limit = 3,
): readonly string[] {
  const lowered = query.toLowerCase();
  const maxDistance = Math.max(1, Math.min(3, Math.floor(query.length / 3)));
  const scored = [...new Set(candidates)]
    .filter((name) => name !== query)
    .map((name) => ({ name, distance: nameEditDistance(query, name) }))
    .filter(({ name, distance }) => {
      const other = name.toLowerCase();
      const contains =
        Math.min(other.length, lowered.length) >= MIN_SUBSTRING_LENGTH &&
        (other.includes(lowered) || lowered.includes(other));
      return distance <= maxDistance || contains;
    });
  return scored
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name);
}

/**
 * The message for a tool name no registered tool matches: it says the tool does not exist,
 * names the observe result field when the name is one, and lists the closest registered tools.
 */
export function formatUnknownToolMessage(
  toolName: string,
  registeredToolNames: Iterable<string>,
  observeResultFields: Iterable<string> = [],
): string {
  const parts = [`Unknown tool "${toolName}". No tool with this name exists.`];
  const field = [...observeResultFields].find(
    (name) => name.toLowerCase() === toolName.toLowerCase(),
  );
  if (field) {
    parts.push(`${field} is a field of the observe result; call observe and read ${field}.`);
  }
  const suggestions = closestNames(toolName, registeredToolNames);
  if (suggestions.length > 0) {
    parts.push(`Closest tools: ${suggestions.join(", ")}.`);
  }
  return parts.join(" ");
}
