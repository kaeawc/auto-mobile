/** Scope shared-logger assertions to diagnostics owned by the code under test. */
export function loggerCallsWithPrefix<Call extends readonly [string, ...unknown[]]>(
  calls: readonly Call[],
  ...prefixes: string[]
): Call[] {
  return calls.filter(([message]) => prefixes.some((prefix) => message.startsWith(prefix)));
}
