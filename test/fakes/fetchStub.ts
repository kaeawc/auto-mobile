type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** A `typeof fetch` over `respond`. The expando `preconnect` is what Bun's fetch type adds. */
export function fetchStub(
  respond: (input: FetchInput, init?: FetchInit) => Promise<Response>,
): typeof fetch {
  const stub = (input: FetchInput, init?: FetchInit): Promise<Response> => respond(input, init);
  stub.preconnect = (): void => {};
  return stub;
}
