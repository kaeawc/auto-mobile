import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import {
  formatNavigationTimeoutError,
  probePageStateAfterNavigateTimeout,
  probeWhepPageReachable,
  type WhepPageProbeDependencies,
  type WhepPageProbeResult,
  type WhepPageState,
} from "./whepNavigationReadiness";

const url = "http://127.0.0.1:8889/device-capture-ios";

describe("probeWhepPageReachable", () => {
  const signal = new AbortController().signal;
  let timeout: Mock<typeof AbortSignal.timeout>;
  let warn: Mock<typeof console.warn>;

  beforeEach(() => {
    // Fake the timeout factory so these fetch-only tests never schedule timers.
    timeout = spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
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

describe("probePageStateAfterNavigateTimeout", () => {
  let warn: Mock<typeof console.warn>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test.each(["loading", "interactive", "complete"])(
    "captures %s document state and the current URL",
    async (readyState) => {
      const state = { readyState, href: url };
      expect(await probePageStateAfterNavigateTimeout(async () => state)).toEqual(state);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("captures an about:blank page that never navigated", async () => {
    const state = { readyState: "complete", href: "about:blank" };
    expect(await probePageStateAfterNavigateTimeout(async () => state)).toEqual(state);
  });

  test.each([new Error("Runtime.evaluate timed out"), "CDP closed"])(
    "logs evaluation rejection and returns unavailable: %s",
    async (error) => {
      expect(
        await probePageStateAfterNavigateTimeout(async () => {
          throw error;
        }),
      ).toEqual({ unavailable: error instanceof Error ? error.message : error });
      expect(warn).toHaveBeenCalledWith("WHEP page state probe failed", error);
    },
  );

  test("converts a synchronous evaluation failure into unavailable", async () => {
    const error = new Error("CDP send failed");
    expect(
      await probePageStateAfterNavigateTimeout(() => {
        throw error;
      }),
    ).toEqual({ unavailable: error.message });
    expect(warn).toHaveBeenCalledWith("WHEP page state probe failed", error);
  });

  test.each([
    null,
    undefined,
    "complete",
    42,
    {},
    { readyState: "complete" },
    { href: url },
    { readyState: 42, href: url },
    { readyState: "complete", href: 42 },
  ])("reports invalid page state as unavailable: %j", async (state) => {
    expect(await probePageStateAfterNavigateTimeout(async () => state)).toEqual({
      unavailable: "Page state evaluation did not return readyState and href",
    });
    expect(warn).toHaveBeenCalledWith("WHEP page state probe failed", expect.any(Error));
  });
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
        pageState: { readyState: "complete", href: "about:blank" },
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        `${original.message}; ${expected}; pageState=complete/about:blank; ${chromeDiagnostics}`,
      );
    },
  );

  test.each<{ pageState: WhepPageState; expected: string }>([
    {
      pageState: { readyState: "interactive", href: url },
      expected: `interactive/${url}`,
    },
    {
      pageState: { unavailable: "Runtime.evaluate timed out" },
      expected: "unavailable: Runtime.evaluate timed out",
    },
  ])("formats page state: $expected", ({ pageState, expected }) => {
    const error = formatNavigationTimeoutError(new Error("navigate timed out"), {
      url,
      probe: { reachable: true, status: 200 },
      chromeVersion: "Chrome/155.0.8059.79",
      chromeDiagnostics: "chrome exitCode=null signal=null log=(updater output only)",
      pageState,
    });

    expect(error.message).toBe(
      `navigate timed out; whepPage=reachable status 200; chromeVersion=Chrome/155.0.8059.79; pageState=${expected}; chrome exitCode=null signal=null log=(updater output only)`,
    );
  });
});
