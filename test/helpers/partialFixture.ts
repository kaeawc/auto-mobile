/**
 * Build a deliberately partial or off-spec fixture object typed as `T`.
 *
 * Tests use this to feed the real code shapes that capture produces but the
 * static model does not spell out (single-object `node` slots, string
 * booleans, array bounds). Centralizing it keeps the test files free of
 * `as any`.
 */
export function partialFixture<T extends object>(attrs: Record<string, unknown>): T {
  return Object.assign({} as T, attrs);
}

/** Like {@link partialFixture}, for the array form captures emit in single-node slots. */
export function partialFixtureArray<T extends object>(items: readonly object[]): T {
  return Object.assign([], items) as T;
}
