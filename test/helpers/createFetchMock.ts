type JsonResponse = Pick<Response, "ok" | "json">;

/** Build a complete fetch replacement from the response surface a JSON poll uses. */
export function createFetchMock(
  handler: (...args: Parameters<typeof fetch>) => Promise<JsonResponse>,
): typeof fetch {
  class MockResponse extends Response implements Pick<Response, "json"> {
    constructor(private readonly response: JsonResponse) {
      super(null, { status: response.ok ? 200 : 500 });
    }
    override json(): Promise<unknown> {
      return this.response.json();
    }
  }
  return Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> =>
      new MockResponse(await handler(...args)),
    { preconnect: () => {} },
  );
}
