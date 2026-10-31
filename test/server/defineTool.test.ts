import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { defineDeviceTool, definePlainTool, type ToolRegistrar } from "../../src/server/defineTool";

const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };

interface Registration {
  readonly kind: "plain" | "deviceAware";
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  readonly handler: (...args: never[]) => Promise<unknown>;
  readonly options: unknown;
}

function fakeRegistrar(): { registrar: ToolRegistrar; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const registrar = {
    register: (name, description, schema, registration) => {
      const { handler, ...options } =
        typeof registration === "function" ? { handler: registration } : registration;
      registrations.push({ kind: "plain", name, description, schema, handler, options });
    },
    registerDeviceAware: (name, description, schema, registration) => {
      const { handler, ...options } =
        typeof registration === "function" ? { handler: registration } : registration;
      registrations.push({ kind: "deviceAware", name, description, schema, handler, options });
    },
  } as ToolRegistrar;
  return { registrar, registrations };
}

describe("defineDeviceTool", () => {
  const tool = defineDeviceTool({
    name: "exampleTool",
    description: "Example",
    input: z.object({ count: z.number().int(), label: z.string().optional() }),
    handler: async (_device, args) => {
      return { total: args.count + 1, deviceId: args.deviceId, label: args.label };
    },
    options: { defaultEnabled: false },
  });

  test("applies device targeting and strictness to the schema", () => {
    expect(tool.schema.parse({ count: 1, deviceId: "emulator-5554", platform: "android" })).toEqual(
      { count: 1, deviceId: "emulator-5554", platform: "android" },
    );
    expect(() => tool.schema.parse({ count: 1, undeclared: true })).toThrow();
    expect(() => tool.schema.parse({ count: "1" })).toThrow();
  });

  test("registers the final schema and the handler through registerDeviceAware", async () => {
    const { registrar, registrations } = fakeRegistrar();
    tool.register(registrar);
    expect(registrations).toHaveLength(1);
    const [registration] = registrations;
    expect(registration.kind).toBe("deviceAware");
    expect(registration.name).toBe("exampleTool");
    expect(registration.description).toBe("Example");
    expect(registration.schema).toBe(tool.schema);
    expect(registration.options).toEqual({ defaultEnabled: false });
    expect(
      await Reflect.apply(registration.handler, undefined, [
        device,
        { count: 1, deviceId: "emulator-5554" },
      ]),
    ).toEqual({
      total: 2,
      deviceId: "emulator-5554",
      label: undefined,
    });
  });
});

describe("definePlainTool", () => {
  const tool = definePlainTool({
    name: "plainExample",
    description: "Plain",
    input: z.object({ name: z.string() }),
    handler: async (args) => args.name.toUpperCase(),
  });

  test("is strict and registers through register", async () => {
    expect(() => tool.schema.parse({ name: "a", extra: 1 })).toThrow();
    const { registrar, registrations } = fakeRegistrar();
    tool.register(registrar);
    expect(registrations.map((r) => [r.kind, r.name])).toEqual([["plain", "plainExample"]]);
    expect(await Reflect.apply(registrations[0].handler, undefined, [{ name: "ab" }])).toBe("AB");
  });
});

describe("late-bound handlers", () => {
  const tool = defineDeviceTool({
    name: "lateBound",
    description: "Late",
    input: z.object({ n: z.number() }),
  });

  test("register takes the handler built from dependencies", async () => {
    const { registrar, registrations } = fakeRegistrar();
    tool.register(registrar, async (_device, args) => args.n * 2);
    expect(registrations[0].schema).toBe(tool.schema);
    expect(await Reflect.apply(registrations[0].handler, undefined, [device, { n: 2 }])).toBe(4);
  });

  test("register without any handler fails loudly", () => {
    const { registrar } = fakeRegistrar();
    expect(() => tool.register(registrar)).toThrow("without a handler");
  });
});
