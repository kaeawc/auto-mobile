/**
 * Return whether an iOS CtrlProxy node exposes the standard accessibility
 * header trait. Current released CtrlProxy runners include this in extras.
 */
export function hasIosHeaderTrait(extras: unknown): boolean {
  if (!extras || typeof extras !== "object") {
    return false;
  }

  const traits = (extras as Record<string, unknown>)["sdk.accessibilityTraits"];
  return typeof traits === "string" && traits.split(",").some((trait) => trait.trim() === "header");
}
