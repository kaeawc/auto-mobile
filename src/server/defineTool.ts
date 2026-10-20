import type { z, ZodType } from "zod/v4";
import type { BootedDevice } from "../models";
import {
  ToolRegistry,
  type DeviceAwareToolOptions,
  type PlainToolOptions,
  type ProgressCallback,
} from "./toolRegistry";
import { erased } from "./toolRegistryErasure";
import { addDeviceTargetingToSchema } from "../utils/schemaHelpers";

/**
 * Typed tool definitions (#11824). The handler's `args` are inferred from the
 * zod input schema, so a hand-written `interface *Args` can no longer drift from
 * the wire schema (#6154). Type erasure to the registry's `any` handler
 * signature happens once, in `register`; the definition site is fully checked.
 *
 * This types the INPUT only. The earlier decision not to thread an output
 * generic through every site (`src/server/internalToolPayloads.ts`) stands.
 */

type ObjectSchema = z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>;

/** `input` made strict (#6712): an undeclared caller argument is rejected, not deleted. */
type StrictInput<I extends ObjectSchema> = ReturnType<I["strict"]>;

/** The schema a device-aware tool advertises and parses: strict, plus device targeting. */
export type DeviceToolSchema<I extends ObjectSchema> = ReturnType<
  typeof addDeviceTargetingToSchema<I["shape"], z.core.$strict>
>;

/** The handler of a device tool defined with {@link defineDeviceTool}. */
export type DeviceToolHandler<I extends ObjectSchema> = (
  device: BootedDevice,
  args: z.output<DeviceToolSchema<I>>,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface DeviceToolDefinition<I extends ObjectSchema> {
  readonly name: string;
  readonly description: string;
  /** The tool's own arguments. Strictness and device targeting are applied by the helper. */
  readonly input: I;
  /**
   * Omit when the handler is built from dependencies at registration time; pass it to
   * `register(registry, handler)` instead. The schema is still defined once, at module scope.
   */
  readonly handler?: DeviceToolHandler<I>;
  readonly options?: DeviceAwareToolOptions<z.output<DeviceToolSchema<I>>>;
}

export type PlainToolHandler<I extends ObjectSchema> = (
  args: z.output<StrictInput<I>>,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface PlainToolDefinition<I extends ObjectSchema> {
  readonly name: string;
  readonly description: string;
  readonly input: I;
  readonly handler?: PlainToolHandler<I>;
  readonly options?: PlainToolOptions;
}

/** The registry surface a defined tool registers through; narrowed so tests can fake it. */
export type ToolRegistrar = Pick<typeof ToolRegistry, "register" | "registerDeviceAware">;

export interface DefinedTool<Schema, Handler> {
  readonly name: string;
  /** The final advertised and parsed schema, for callers that assert on the wire contract. */
  readonly schema: Schema;
  register(registry?: ToolRegistrar, handler?: Handler): void;
}

function requireHandler<H>(name: string, handler: H | undefined): H {
  if (handler === undefined) {
    throw new Error(`Tool ${name} was defined without a handler and registered without one`);
  }
  return handler;
}

/**
 * Define a device-aware tool. The helper applies `.strict()` and device
 * targeting itself, so a definition cannot forget either.
 */
export function defineDeviceTool<I extends ObjectSchema>(
  definition: DeviceToolDefinition<I>,
): DefinedTool<DeviceToolSchema<I>, DeviceToolHandler<I>> {
  const strict: z.ZodObject<I["shape"], z.core.$strict> = definition.input.strict();
  const schema = addDeviceTargetingToSchema(strict);
  return {
    name: definition.name,
    schema,
    register: (registry = ToolRegistry, handler = definition.handler) => {
      registry.registerDeviceAware<ZodType<z.output<DeviceToolSchema<I>>>>(
        definition.name,
        definition.description,
        erased<ZodType<z.output<DeviceToolSchema<I>>>>(schema),
        requireHandler(definition.name, handler),
        definition.options,
      );
    },
  };
}

/** Define a plain (no device) tool. The helper applies `.strict()` itself. */
export function definePlainTool<I extends ObjectSchema>(
  definition: PlainToolDefinition<I>,
): DefinedTool<StrictInput<I>, PlainToolHandler<I>> {
  const schema = definition.input.strict() as StrictInput<I>;
  return {
    name: definition.name,
    schema,
    register: (registry = ToolRegistry, handler = definition.handler) => {
      registry.register<ZodType<z.output<StrictInput<I>>>>(
        definition.name,
        definition.description,
        erased<ZodType<z.output<StrictInput<I>>>>(schema),
        requireHandler(definition.name, handler),
        definition.options,
      );
    },
  };
}
