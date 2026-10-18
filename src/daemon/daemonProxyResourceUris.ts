export function isFreshSessionScreenshotUri(uri: string, sessionUuid: string): boolean {
  return uri === `automobile:device-session/${sessionUuid}/screenshot`;
}

// A tool-output artifact read (`automobile:tool-output/<id>`) is a plain host
// file read routed through the session-independent resource registry — no device
// access and no session data. So unlike the fresh-screenshot exemption it is not
// scoped to any session, and it must stay retrievable after a terminal release
// (e.g. executePlan auto-releases its bound session, then emits an artifact
// resourceUri that would otherwise be fenced). Kept in lockstep with the
// `automobile:tool-output/` prefix in src/server/toolOutputResources.ts.
export function isToolOutputResourceUri(uri: string): boolean {
  return uri.startsWith("automobile:tool-output/");
}

// The session UUID embedded in a session-scoped observation resource URI, or
// undefined for any other URI. Kept in lockstep with RESOURCE_URIS in
// src/server/observationResources.ts.
export function sessionScopedObservationUriSessionUuid(uri: string): string | undefined {
  const match = uri.match(
    /^automobile:(?:observation\/session\/([^/]+)\/latest(?:\/screenshot)?|device-session\/([^/]+)\/screenshot)$/,
  );
  return match?.[1] ?? match?.[2];
}

/**
 * Whether a resource URI names a device session at all: every `automobile:device-session/<id>/...`
 * and `automobile:observation/session/<id>/...` form, whatever follows the session segment. These
 * two prefixes are where the server registers its session-scoped templates
 * (test/daemon/proxySessionNamingResourceFence.test.ts checks every registered template against
 * this), so a new session-scoped resource is covered without listing it here.
 */
export function resourceUriNamesSession(uri: string): boolean {
  return /^automobile:(?:device-session|observation\/session)\/[^/?#]+/.test(uri);
}
