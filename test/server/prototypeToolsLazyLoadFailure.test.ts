import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice } from "../../src/models";
import { registerPrototypeTools } from "../../src/server/prototypeTools/registration";
import type { PrototypeToolRuntimeModule } from "../../src/server/prototypeTools/types";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { LAZY_IMPORT_FAILURE, recoveringLazyModule } from "../helpers/recoveringLazyModule";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

describe("prototype runtime import failure (#17721)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
  });
  afterEach(() => restore());

  test("a call returns the load error and the next call builds the runtime", async () => {
    const calls: unknown[] = [];
    let built = 0;
    const runtimeModule: PrototypeToolRuntimeModule = {
      createPrototypeToolRuntime: () => {
        built++;
        return {
          handler: async (_device, input) => {
            calls.push(input);
            return { content: [{ type: "text", text: "ok" }] };
          },
          dispose: () => undefined,
        };
      },
    };
    const lazy = recoveringLazyModule("prototype", () => runtimeModule);
    const dispose = registerPrototypeTools({}, lazy.module);
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;

    const failed = handler(device, { action: "status" });
    await expect(failed).rejects.toBeInstanceOf(ActionableError);
    await expect(failed).rejects.toThrow(
      `Failed to load the prototype module: ${LAZY_IMPORT_FAILURE}`,
    );
    expect(built).toBe(0);

    lazy.recover();
    expect(await handler(device, { action: "status", id: "b" })).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(built).toBe(1);
    expect(calls).toEqual([{ action: "status", id: "b" }]);
    expect(lazy.attempts()).toBe(2);
    dispose();
  });
});
