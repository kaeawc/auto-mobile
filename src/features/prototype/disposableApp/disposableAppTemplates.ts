import { ActionableError } from "../../../models/ActionableError";
import type { PrototypeJson } from "../prototypeJson";
import { requiredPrototypeCapabilities } from "../prototypeCapabilityGates";

/**
 * Template flavors a platform stamper offers (#14184, owner decision on #14289): the host picks
 * the smallest flavor that advertises every capability the spec requires, and refuses with the
 * missing capabilities otherwise, in the style of the `PROTOTYPE_SPEC_CAPABILITY_GATES` refusals.
 */
export interface DisposableAppTemplate {
  /** Flavor name, such as `base` or `media`. */
  name: string;
  /** Prototype capabilities the flavor's renderer advertises. */
  capabilities: readonly string[];
  /** Relative install cost; the smallest covering flavor wins, ties break by name. */
  size: number;
}

export function selectDisposableAppTemplate(
  spec: PrototypeJson,
  templates: readonly DisposableAppTemplate[],
): DisposableAppTemplate {
  const required = requiredPrototypeCapabilities(spec);
  const ordered = [...templates].sort(
    (left, right) => left.size - right.size || left.name.localeCompare(right.name),
  );
  const missingFrom = (template: DisposableAppTemplate): string[] =>
    required.filter((capability) => !template.capabilities.includes(capability));
  const covering = ordered.find((template) => missingFrom(template).length === 0);
  if (covering) {
    return covering;
  }
  if (ordered.length === 0) {
    throw new ActionableError(
      "No disposable app template is available for this platform. Nothing was installed.",
    );
  }
  const closest = ordered.reduce((best, template) =>
    missingFrom(template).length < missingFrom(best).length ? template : best,
  );
  throw new ActionableError(
    `The spec needs ${missingFrom(closest).join(", ")}, which no disposable app template advertises (closest: ${closest.name}; available: ${ordered.map((template) => template.name).join(", ")}). Remove the feature from the spec or install a template flavor that supports it. Nothing was installed.`,
  );
}
