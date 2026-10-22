import { validatePrototypeSpec } from "../prototypeValidation";
import { collectPrototypeAssetReferences } from "../prototypeAssetReferences";
import { bundleAssert } from "./bundleContract";
import { parseBundleJson } from "./bundleJson";

export function bundleSpecReferences(
  bytes: Uint8Array,
): ReturnType<typeof collectPrototypeAssetReferences> {
  const spec = parseBundleJson(bytes, "spec_invalid_json", "spec.json");
  const validated = validatePrototypeSpec(spec);
  bundleAssert(validated.success, "spec_invalid", "spec.json");
  // Collect from the validated expanded spec: unused components and opaque JSON are not references.
  return collectPrototypeAssetReferences(validated.data);
}
