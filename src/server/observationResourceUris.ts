/**
 * Canonical builder for the observation-scoped screenshot resource URI
 * (issues #7000, #7018). The resource template
 * `automobile:observation/{deviceId}/{observationId}/screenshot` (registered in
 * `observationResources.ts`) captures each path segment with the registry's
 * `[^/&]+` matcher and its handler decodes the captured segments with
 * `decodeURIComponent`, so every emitted URI encodes its two identity segments
 * with `encodeURIComponent`. That guarantees a segment containing a `/`, `?`,
 * `&`, or other reserved character round-trips losslessly back to the same
 * `{deviceId}` / `{observationId}` params the template parses.
 *
 * This is the single encoder both the resource registration and the observe
 * tool output go through, so an emitted `observationScreenshotResourceUri` is
 * guaranteed to resolve to the resource it names.
 */
export const OBSERVATION_SCREENSHOT_URI_TEMPLATE =
  "automobile:observation/{deviceId}/{observationId}/screenshot" as const;

/**
 * Build the fully-encoded observation-scoped screenshot resource URI for a
 * resolved device and observation identity. Both segments are
 * `encodeURIComponent`-encoded so the URI round-trips through the template in
 * {@link OBSERVATION_SCREENSHOT_URI_TEMPLATE}.
 */
export function buildObservationScreenshotUri(deviceId: string, observationId: string): string {
  return `automobile:observation/${encodeURIComponent(deviceId)}/${encodeURIComponent(observationId)}/screenshot`;
}
