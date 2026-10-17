/**
 * Compile-time contract of `defineDeviceTool` / `definePlainTool` (#11824). Included by the
 * typecheck gate (`tsconfig.json` matches `test/**\/*.typecheck.ts`); never executed. If the
 * handler args stop being inferred from the schema, an unused `@ts-expect-error` fails the gate.
 */
import { z } from "zod/v4";
import { defineDeviceTool, definePlainTool } from "../../src/server/defineTool";

export const deviceTool = defineDeviceTool({
  name: "typecheckDevice",
  description: "typecheck",
  input: z.object({ count: z.number().int(), label: z.string().optional() }),
  handler: async (device, args) => {
    const total: number = args.count + 1;
    const label: string | undefined = args.label;
    // Device targeting is applied by the helper and is part of the parsed args.
    const deviceId: string | undefined = args.deviceId;
    // @ts-expect-error `cnt` is not declared on the input schema.
    void args.cnt;
    // @ts-expect-error `count` is a number, not a string.
    const wrong: string = args.count;
    return { total, label, deviceId, wrong, platform: device.platform };
  },
});

export const plainTool = definePlainTool({
  name: "typecheckPlain",
  description: "typecheck",
  input: z.object({ name: z.string() }),
  handler: async (args) => {
    const upper: string = args.name.toUpperCase();
    // @ts-expect-error a plain tool carries no device targeting.
    void args.deviceId;
    return upper;
  },
});

// The handler must not declare args the schema does not produce.
export const rejected = defineDeviceTool({
  name: "typecheckRejected",
  description: "typecheck",
  input: z.object({ a: z.string() }),
  // @ts-expect-error `b` is not produced by the input schema.
  handler: async (_device, args: { b: string }) => args.b,
});
