import type { ZodType } from "zod/v4";
import type {
  DeviceAwareToolHandler,
  DeviceAwareToolOptions,
  PlainToolOptions,
  ToolHandler,
  ToolSchema,
} from "./toolRegistryTypes";

/**
 * The registry's one type-erasure point (#11824). `register` / `registerDeviceAware` infer handler
 * arguments from the schema at the definition site; the registry stores everything by wire shape
 * (`Record<string, unknown>`), because a heterogeneous tool map cannot keep per-tool argument
 * types. A no-op at runtime; read the call site's type argument as the stored shape.
 */
export function erased<Stored>(value: unknown): Stored {
  return value as Stored;
}

/**
 * A registration's fourth argument as its handler and options: a bare handler (a tool with no
 * options) or a `{ handler, ...options }` registration.
 */
export function splitRegistration<
  Handler extends (...args: never[]) => unknown,
  Registration extends { handler: Handler },
>(
  registration: Handler | Registration,
): { handler: Handler; options: Omit<Registration, "handler"> | Record<string, never> } {
  if (typeof registration === "function") {
    return { handler: registration, options: {} };
  }
  const { handler, ...options } = registration;
  return { handler, options };
}

/** A plain registration's schema, handler and options, stored by wire shape. */
export function erasePlain(schema: ZodType, handler: unknown, options: unknown) {
  return {
    schema: erased<ToolSchema>(schema),
    handler: erased<ToolHandler>(handler),
    options: erased<PlainToolOptions>(options),
  };
}

/** A device-aware registration's schema, handler and options, stored by wire shape. */
export function eraseDeviceAware(schema: ZodType, handler: unknown, options: unknown) {
  return {
    schema: erased<ToolSchema>(schema),
    handler: erased<DeviceAwareToolHandler>(handler),
    options: erased<DeviceAwareToolOptions>(options),
  };
}
