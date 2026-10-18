/**
 * Typed fake for `globalThis.fetch` used by the iOS CtrlProxy client tests.
 *
 * The client only reads `ok` and `json()` from the runner's `/sdk-events`
 * response, so tests describe a partial Response and this builder is the single
 * place that widens it to the full `fetch` signature (one assertion, instead of
 * a double cast at every call site).
 */
export type FakeFetchResponse = Partial<Response>;

export type FakeFetchHandler = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => FakeFetchResponse | Promise<FakeFetchResponse>;

export function createFakeFetch(handler: FakeFetchHandler): typeof fetch {
  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // Partial<Response> -> Response: the single widening point for the fake.
    return (await handler(input, init)) as Response;
  };
  return Object.assign(fakeFetch, { preconnect: () => {} });
}
