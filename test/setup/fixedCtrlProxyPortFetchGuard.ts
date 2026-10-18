import { isUnitTestPath } from "./realDeviceToolSpawnGuard";

/** First host port of the CtrlProxy range: `adb forward`s and iOS runners bind here. */
export const FIXED_CTRL_PROXY_PORT_START = 8765;
/** Last host port of the default CtrlProxy range (100 devices). */
export const FIXED_CTRL_PROXY_PORT_END = 8864;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Whether `input` targets a loopback host port in the fixed CtrlProxy range. */
export function isFixedCtrlProxyPortUrl(input: unknown): boolean {
  const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  if (typeof raw !== "string") {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Relative or malformed: not a dial to a loopback port.
    return false;
  }
  const port = Number(url.port);
  return (
    LOOPBACK_HOSTS.has(url.hostname) &&
    port >= FIXED_CTRL_PROXY_PORT_START &&
    port <= FIXED_CTRL_PROXY_PORT_END
  );
}

/**
 * Make unit-test `fetch` calls to the fixed CtrlProxy host ports fail like a
 * refused connection instead of dialing them (#11106). Those ports are held
 * open by `adb forward`s and iOS runners, so a unit test that reached them
 * showed up as a foreign client connected to a live device's forward.
 */
export function installFixedCtrlProxyPortFetchGuard(
  target: { fetch: typeof fetch },
  getTestFile: () => string,
): void {
  const original = target.fetch;
  const guarded = (input: FetchInput, init?: FetchInit): Promise<Response> => {
    if (isUnitTestPath(getTestFile()) && isFixedCtrlProxyPortUrl(input)) {
      const dialed = input instanceof Request ? input.url : String(input);
      return Promise.reject(
        new TypeError(
          `Unable to connect: unit tests must not dial fixed CtrlProxy host ports (${dialed}); inject a fake fetch (#11106)`,
        ),
      );
    }
    return original(input, init);
  };
  guarded.preconnect = original.preconnect;
  target.fetch = guarded;
}
