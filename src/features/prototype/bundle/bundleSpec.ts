import { prototypeShaderFields } from "../prototypeShaders";
import { BundleFailure } from "./bundleContract";
import { validatePrototypeSpec } from "../prototypeValidation";
import { PROTOTYPE_LARGE_BUDGET } from "../prototypeRuntimeBudget";
import { collectPrototypeAssetReferences } from "../prototypeAssetReferences";
import { bundleAssert } from "./bundleContract";
import { parseBundleJson } from "./bundleJson";

export function bundleSpecReferences(
  bytes: Uint8Array,
): ReturnType<typeof collectPrototypeAssetReferences> {
  const spec = parseBundleJson(bytes, "spec_invalid_json", "spec.json");
  if (prototypeShaderFields(spec).length) {
    throw new BundleFailure(
      "custom_shaders_unsupported",
      "spec.json",
      "ProtoViewer bundles refuse style.shader and AGSL assets; remove custom shaders.",
    );
  }
  // A bundle needing the large budget records prototype_large_budget_v1 in its requires (#18804).
  const validated = validatePrototypeSpec(spec, { budget: PROTOTYPE_LARGE_BUDGET });
  bundleAssert(validated.success, "spec_invalid", "spec.json");
  // Collect from the validated expanded spec: unused components and opaque JSON are not references.
  return collectPrototypeAssetReferences(validated.data);
}
