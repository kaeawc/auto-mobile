import { describe, expect, it } from "bun:test";
import { isFailedNetworkRequest } from "../../src/utils/networkRequestOutcome";

describe("isFailedNetworkRequest", () => {
  it.each([
    { statusCode: 0, error: "The request timed out", failed: true },
    { statusCode: 0, failed: true },
    { statusCode: null, failed: true },
    { statusCode: undefined, failed: true },
    { statusCode: NaN, failed: true },
    { statusCode: Infinity, failed: true },
    { statusCode: -1, failed: true },
    { statusCode: 100, failed: false },
    { statusCode: 200, failed: false },
    { statusCode: 301, failed: false },
    { statusCode: 404, failed: true },
    { statusCode: 500, failed: true },
    { statusCode: 200, error: "cancelled", failed: true },
    { statusCode: 200, error: "", failed: false },
    { statusCode: 200, error: " \t\n\u00a0\ufeff", failed: false },
  ])("classifies %j", ({ statusCode, error, failed }) => {
    expect(isFailedNetworkRequest({ statusCode, error })).toBe(failed);
  });
});
