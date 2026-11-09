import {
  envPrototypeFullSchemaFlag,
  type PrototypeFullSchemaFlag,
} from "../../../daemon/staticToolDefinitions";

const PROTOTYPE_TOOL_NAME = "prototype";

/** Turns the advertised prototype input schema into its full-spec form. */
export interface PrototypeSpecSchemaInliner {
  inline(inputSchema: Record<string, unknown>): Record<string, unknown>;
}

const inlinedBySource = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

/**
 * The production inliner. The spec schema module is required on first use only, so a connection
 * that never asks for the full schema never loads it here; the registry caches the terse source
 * object, so one inlined copy is kept per source.
 */
export const specSchemaInliner: PrototypeSpecSchemaInliner = {
  inline(inputSchema) {
    const cached = inlinedBySource.get(inputSchema);
    if (cached) {
      return cached;
    }
    const { withFullAdvertisedSpecSchema } =
      require("../../../features/prototype/prototypeSpecJsonSchema") as typeof import("../../../features/prototype/prototypeSpecJsonSchema");
    const inlined = withFullAdvertisedSpecSchema(inputSchema);
    inlinedBySource.set(inputSchema, inlined);
    return inlined;
  },
};

export interface PrototypeSchemaPresentation {
  /** The daemon process's own `AUTOMOBILE_PROTOTYPE_FULL_SCHEMA`, which the registry was built with. */
  readonly daemonDefault: PrototypeFullSchemaFlag;
  readonly inliner: PrototypeSpecSchemaInliner;
}

export const defaultPrototypeSchemaPresentation: PrototypeSchemaPresentation = {
  daemonDefault: envPrototypeFullSchemaFlag,
  inliner: specSchemaInliner,
};

/**
 * Serve one connection the prototype `spec` schema it asked for (#17723). The registry advertises
 * the form the daemon's own flag selects; a connection whose client set the flag gets the full
 * form even when the daemon did not. Every other definition, and the default listing, is returned
 * unchanged.
 */
export function withConnectionPrototypeSchema<
  T extends { name: string; inputSchema: Record<string, unknown> },
>(definitions: T[], connectionWantsFull: boolean, presentation: PrototypeSchemaPresentation): T[] {
  if (!connectionWantsFull || presentation.daemonDefault.isEnabled()) {
    return definitions;
  }
  return definitions.map((definition) =>
    definition.name === PROTOTYPE_TOOL_NAME
      ? { ...definition, inputSchema: presentation.inliner.inline(definition.inputSchema) }
      : definition,
  );
}
