/**
 * Single source of truth for the navigation node-screenshot resource URI shape.
 *
 * #5534 scoped the screenshot resource by an explicit `?appId=` so an offline /
 * cross-app browse resolves the screenshot under the named app instead of the
 * daemon's current foreground app (#4933). Every emitter of this URI — the
 * resolver (navigationResources), the exported graph summary, and the live
 * telemetry stream — must produce the identical shape, so they all build it here
 * rather than re-inlining the literal (#5600). When `appId` is absent the caller
 * gets the legacy unscoped form, which resolves against the current app.
 */
export function buildNavigationNodeScreenshotUri(nodeId: number, appId?: string | null): string {
  const base = `automobile:navigation/nodes/${nodeId}/screenshot`;
  return appId ? `${base}?appId=${encodeURIComponent(appId)}` : base;
}
