import {
  PROTOTYPE_LARGE_BUDGET_CAPABILITY,
  PROTOTYPE_REMOTE_IMAGE_CAPABILITY,
} from "../../../observe/android/ctrlProxyProtocol";
import { prototypeDeclaredCapabilities } from "../../prototypeDeclaredCapabilities";
import { prototypeRemoteImageFields } from "../../prototypeRemoteImageFields";
import { prototypeLargeBudgetFields } from "../../prototypeRuntimeBudget";
import { record } from "../../prototypeTemplate";

/**
 * The capabilities the host's gate table can require of a spec that the web library does not
 * advertise (#16453): it draws no remote image and keeps the base runtime budget. Every other
 * capability the table names is advertised, so these are the only ones a bare spec's derived
 * `requires` can be refused for, besides the spec's own declared `requires`.
 */
export const PROTOTYPE_WEB_UNADVERTISED_DERIVED_CAPABILITIES: readonly string[] = [
  PROTOTYPE_LARGE_BUDGET_CAPABILITY,
  PROTOTYPE_REMOTE_IMAGE_CAPABILITY,
];

/**
 * The `requires` an envelope would carry for `spec`, as far as the web library can refuse it: the
 * spec's declared capabilities plus the derived ones above. The gate table itself is not
 * browser-safe, so this reads only the two detectors those capabilities need.
 */
export function prototypeWebBareSpecRequires(spec: Readonly<Record<string, unknown>>): string[] {
  return [
    ...new Set([
      ...prototypeDeclaredCapabilities(record(spec)?.requires),
      ...(prototypeRemoteImageFields(spec).length > 0 ? [PROTOTYPE_REMOTE_IMAGE_CAPABILITY] : []),
      ...(prototypeLargeBudgetFields(spec).length > 0 ? [PROTOTYPE_LARGE_BUDGET_CAPABILITY] : []),
    ]),
  ].sort();
}
