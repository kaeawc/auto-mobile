import { requiredPrototypeCapabilities } from "./prototypeCapabilityGates";
import { object, type PrototypeValidationError } from "./prototypeBindingValidation";

export interface PrototypeStrictOptions {
  supportedCapabilities?: readonly string[];
  library?: boolean;
}

/** Host/device capability negotiation and the additional unprivileged import boundary. */
export function prototypeStrictPolicyError(
  spec: unknown,
  options: PrototypeStrictOptions,
): PrototypeValidationError | undefined {
  if (options.supportedCapabilities !== undefined) {
    const missing = requiredPrototypeCapabilities(spec).filter(
      (name) => !options.supportedCapabilities?.includes(name),
    );
    if (missing.length) {
      return { path: "$", message: `Unsupported capabilities: ${missing.join(", ")}` };
    }
  }
  const window = object(object(spec)?.window);
  if (options.library) {
    if (window?.layer === "system") {
      return { path: "window.layer", message: "Privileged window layer" };
    }
    if (window?.persistence === "device") {
      return { path: "window.persistence", message: "Privileged window persistence" };
    }
  }
  return undefined;
}
