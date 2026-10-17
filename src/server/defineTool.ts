import type { z } from "zod/v4";
import type { BootedDevice } from "../models";
import {
  ToolRegistry,
  type DeviceAwareToolOptions,
  type PlainToolOptions,
  type ProgressCallback,
} from "./toolRegistry";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";

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
export type DeviceToolSchema<I extends ObjectSchema> =
  StrictInput<I> extends z.ZodObject<infer S, infer C>
    ? ReturnType<typeof addDeviceTargetingToSchema<S, C>>
    : never;

export interface DeviceToolDefinition<I extends ObjectSchema> {
  readonly name: string;
  readonly description: string;
  /** The tool's own arguments. Strictness and device targeting are applied by the helper. */
  readonly input: I;
  readonly handler: (
    device: BootedDevice,
    args: z.output<DeviceToolSchema<I>>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly options?: DeviceAwareToolOptions<z.output<DeviceToolSchema<I>>>;
}

export interface PlainToolDefinition<I extends ObjectSchema> {
  readonly name: string;
  readonly description: string;
  readonly input: I;
  readonly handler: (
    args: z.output<StrictInput<I>>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly options?: PlainToolOptions;
}

/** The registry surface a defined tool registers through; narrowed so tests can fake it. */
export type ToolRegistrar = Pick<typeof ToolRegistry, "register" | "registerDeviceAware">;

export interface DefinedTool<Schema> {
  readonly name: string;
  /** The final advertised and parsed schema, for callers that assert on the wire contract. */
  readonly schema: Schema;
  register(registry?: ToolRegistrar): void;
}

/**
 * Define a device-aware tool. The helper applies `.strict()` and device
 * targeting itself, so a definition cannot forget either.
 */
export function defineDeviceTool<I extends ObjectSchema>(
  definition: DeviceToolDefinition<I>,
): DefinedTool<DeviceToolSchema<I>> {
  const strict: z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig> = definition.input.strict();
  // oxlint-disable-next-line auto-mobile/no-unknown-cast -- TypeScript cannot resolve the conditional DeviceToolSchema<I> for a generic I; the runtime value is exactly addDeviceTargetingToSchema(strict).
  const schema = addDeviceTargetingToSchema(strict) as unknown as DeviceToolSchema<I>;
  return {
    name: definition.name,
    schema,
    register: (registry = ToolRegistry) => {
      registry.registerDeviceAware(
        definition.name,
        definition.description,
        schema,
        definition.handler,
        definition.options,
      );
    },
  };
}

/** Define a plain (no device) tool. The helper applies `.strict()` itself. */
export function definePlainTool<I extends ObjectSchema>(
  definition: PlainToolDefinition<I>,
): DefinedTool<StrictInput<I>> {
  const schema = definition.input.strict() as StrictInput<I>;
  return {
    name: definition.name,
    schema,
    register: (registry = ToolRegistry) => {
      registry.register(
        definition.name,
        definition.description,
        schema,
        definition.handler,
        definition.options,
      );
    },
  };
}
