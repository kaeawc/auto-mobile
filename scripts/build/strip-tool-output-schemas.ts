/** Only the static proxy projection is bundled; the committed schemas stay complete. */
export function stripToolOutputSchemas<T extends Record<string, unknown>>(
  definitions: readonly T[],
): Omit<T, "outputSchema">[] {
  return definitions.map((definition) => {
    const stripped = { ...definition };
    delete stripped.outputSchema;
    return stripped;
  });
}
