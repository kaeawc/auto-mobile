export interface WhepPageProbeDependencies {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;
  timeoutMs: number;
}

export type WhepPageProbeResult =
  | { reachable: true; status: number }
  | { reachable: false; reason: string };

/** Any HTTP response proves harness reachability, regardless of its status. */
export async function probeWhepPageReachable(
  url: string,
  deps: WhepPageProbeDependencies,
): Promise<WhepPageProbeResult> {
  try {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(deps.timeoutMs) });
    return { reachable: true, status: response.status };
  } catch (error) {
    // Reachability is diagnostic only; Chrome must still attempt navigation.
    console.warn("WHEP page reachability probe failed", error);
    return { reachable: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export type WhepPageState = { readyState: string; href: string } | { unavailable: string };

export async function probePageStateAfterNavigateTimeout(
  evaluate: () => Promise<unknown>,
): Promise<WhepPageState> {
  try {
    const state = await evaluate();
    if (
      typeof state !== "object" ||
      state === null ||
      !("readyState" in state) ||
      typeof state.readyState !== "string" ||
      !("href" in state) ||
      typeof state.href !== "string"
    ) {
      throw new Error("Page state evaluation did not return readyState and href");
    }
    return { readyState: state.readyState, href: state.href };
  } catch (error) {
    // Page state is best-effort diagnostics; preserve the original navigation failure.
    console.warn("WHEP page state probe failed", error);
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

export interface NavigationTimeoutContext {
  url: string;
  probe: WhepPageProbeResult;
  chromeVersion: string | undefined;
  chromeDiagnostics: string;
  pageState: WhepPageState;
}

export function formatNavigationTimeoutError(
  original: Error,
  context: NavigationTimeoutContext,
): Error {
  const page = context.probe.reachable
    ? `reachable status ${context.probe.status}`
    : `unreachable: ${context.probe.reason}`;
  const pageState =
    "unavailable" in context.pageState
      ? `unavailable: ${context.pageState.unavailable}`
      : `${context.pageState.readyState}/${context.pageState.href}`;
  return new Error(
    `${original.message}; whepPage=${page}; chromeVersion=${context.chromeVersion ?? "unavailable"}; pageState=${pageState}; ${context.chromeDiagnostics}`,
  );
}
