import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  formatNavigationTimeoutError,
  probeWhepPageReachable,
  type WhepPageProbeDependencies,
  type WhepPageProbeResult,
} from "./whepNavigationReadiness";

const url = "http://127.0.0.1:8889/device-capture-ios";

describe("probeWhepPageReachable", () => {
  const signal = new AbortController().signal;
  const timeout = spyOn(AbortSignal, "timeout");
  const warn = spyOn(console, "warn");

  beforeEach(() => {
    // Fake the timeout factory so these fetch-only tests never schedule timers.
    timeout.mockReturnValue(signal);
    warn.mockImplementation(() => {});
  });

  afterEach(() => {
    timeout.mockClear();
    warn.mockClear();
  });

  // Restore global seams before any other test file uses them.
  afterAll(() => {
    timeout.mockRestore();
    warn.mockRestore();
  });

  test.each([200, 404])(
    "treats HTTP %i as reachable and passes the bounded AbortSignal",
    async (status) => {
      const requests: Array<{ url: string; signal: AbortSignal }> = [];
      const fetch: WhepPageProbeDependencies["fetch"] = async (requestUrl, init) => {
        requests.push({ url: requestUrl, signal: init.signal });
        return { status };
      };

      expect(await probeWhepPageReachable(url, { fetch, timeoutMs: 30_000 })).toEqual({
        reachable: true,
        status,
      });
      expect(requests).toEqual([{ url, signal }]);
      expect(requests[0].signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(30_000);
    },
  );

  test.each([new Error("connection refused"), new DOMException("probe aborted", "AbortError")])(
    "reports a rejected fetch as unreachable: %s",
    async (error) => {
      const fetch: WhepPageProbeDependencies["fetch"] = async () => {
        throw error;
      };

      expect(await probeWhepPageReachable(url, { fetch, timeoutMs: 30_000 })).toEqual({
        reachable: false,
        reason: error.message,
      });
      expect(warn).toHaveBeenCalledWith("WHEP page reachability probe failed", error);
    },
  );
});

describe("formatNavigationTimeoutError", () => {
  const cases: Array<{
    probe: WhepPageProbeResult;
    chromeVersion: string | undefined;
    expected: string;
  }> = [
    {
      probe: { reachable: true, status: 200 },
      chromeVersion: "Chrome/141.0.0.0",
      expected: "whepPage=reachable status 200; chromeVersion=Chrome/141.0.0.0",
    },
    {
      probe: { reachable: false, reason: "connection refused" },
      chromeVersion: "Chrome/141.0.0.0",
      expected: "whepPage=unreachable: connection refused; chromeVersion=Chrome/141.0.0.0",
    },
    {
      probe: { reachable: true, status: 404 },
      chromeVersion: undefined,
      expected: "whepPage=reachable status 404; chromeVersion=unavailable",
    },
    {
      probe: { reachable: false, reason: "probe aborted" },
      chromeVersion: undefined,
      expected: "whepPage=unreachable: probe aborted; chromeVersion=unavailable",
    },
  ];

  test.each(cases)(
    "keeps the original message first and includes all diagnostics: $expected",
    ({ probe, chromeVersion, expected }) => {
      const original = new Error("Chrome DevTools Page.navigate command timed out after 30000ms");
      const chromeDiagnostics = "chrome exitCode=null signal=null log=renderer stalled";
      const error = formatNavigationTimeoutError(original, {
        url,
        probe,
        chromeVersion,
        chromeDiagnostics,
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(`${original.message}; ${expected}; ${chromeDiagnostics}`);
    },
  );
});
