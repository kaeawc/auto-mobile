/**
 * Node types renderWebNode hoists into the window's layer (its layer renderers; a test keeps the
 * two equal). Open or closed, such a node leaves nothing in its parent's flow.
 */
export const WEB_LAYER_TYPES: ReadonlySet<string> = new Set(["bottomSheet", "dialog", "snackbar"]);

/** Whether `type` draws only in the window's layer while its `openWhen` holds, never in place. */
export function isWebLayerType(type: unknown): boolean {
  return WEB_LAYER_TYPES.has(String(type));
}
