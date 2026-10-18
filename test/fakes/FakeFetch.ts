/**
 * Typed fake for `globalThis.fetch`. Handlers return complete, real `Response`
 * objects (use {@link jsonResponse}) so no partial-response widening is needed.
 */
export type FakeFetchHandler = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

export function createFakeFetch(handler: FakeFetchHandler): typeof fetch {
  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => handler(input, init);
  // `typeof fetch` also carries Bun's `preconnect`; add it as a real, typed member.
  fakeFetch.preconnect = (): void => {};
  return fakeFetch;
}

/** A 200 response whose body is the JSON encoding of `body` (`null` for `undefined`). */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body ?? null), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Fake fetch that answers every call with a fresh JSON response from `produce`. */
export function createJsonFakeFetch(produce: () => unknown): typeof fetch {
  return createFakeFetch(() => jsonResponse(produce()));
}
