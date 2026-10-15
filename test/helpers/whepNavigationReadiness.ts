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

export interface NavigationTimeoutContext {
  url: string;
  probe: WhepPageProbeResult;
  chromeVersion: string | undefined;
  chromeDiagnostics: string;
}

export function formatNavigationTimeoutError(
  original: Error,
  context: NavigationTimeoutContext,
): Error {
  const page = context.probe.reachable
    ? `reachable status ${context.probe.status}`
    : `unreachable: ${context.probe.reason}`;
  return new Error(
    `${original.message}; whepPage=${page}; chromeVersion=${context.chromeVersion ?? "unavailable"}; ${context.chromeDiagnostics}`,
  );
}
