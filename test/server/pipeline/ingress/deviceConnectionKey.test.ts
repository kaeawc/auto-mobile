import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { InMemoryToolSelectionProfileRegistry } from "../../../../src/daemon/InMemoryToolSelectionProfileRegistry";
import { SessionToolBinding } from "../../../../src/server/SessionToolBinding";
import { createToolCallExecutor } from "../../../../src/server/pipeline/ingress/executeToolCall";
import { createSetActiveDeviceHandler } from "../../../../src/server/setActiveDevice";
import { ToolRegistry } from "../../../../src/server/toolRegistry";
import { SELECTS_ACTIVE_DEVICE } from "../../../../src/server/toolRegistryTypes";
import { FakeDeviceReadiness } from "../../../fakes/FakeDeviceReadiness";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { isolateToolRegistry, withTemporaryTool } from "../../../helpers/withTemporaryTool";

isolateToolRegistry();

test("stateless ingress carries each server's header binding key to the device pin without injecting an MCP id", async () => {
  const deviceA = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" } as const;
  const deviceB = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" } as const;
  const readiness = new FakeDeviceReadiness();
  readiness.setConnectedDevices([deviceA, deviceB]);
  const handler = createSetActiveDeviceHandler({
    legacyDeviceSelection: () => readiness,
    resumeCtrlProxy: async () => {},
  });
  const bindings = new SessionToolBinding(undefined, undefined, new FakeIdGenerator());
  const receivedIds: unknown[] = [];
  try {
    await withTemporaryTool(
      "setActiveDevice",
      () => {
        ToolRegistry.register(
          "setActiveDevice",
          "Select device",
          z.object({ deviceId: z.string() }),
          {
            handler: async (args) => {
              receivedIds.push(Reflect.get(args, "__mcpSessionId"));
              return handler(args);
            },
            defaultEnabled: true,
            ...SELECTS_ACTIVE_DEVICE,
          },
        );
      },
      async () => {
        for (const [key, device] of [
          ["client-a", deviceA],
          ["client-b", deviceB],
        ] as const) {
          const execute = createToolCallExecutor({
            options: {},
            daemonMode: true,
            serverBindingKey: key,
            sessionToolBinding: bindings,
            planExecutionLock: { evaluate: () => ({ blocked: false, scope: "session" }) },
            toolSelectionProfileRegistry: new InMemoryToolSelectionProfileRegistry(),
            listSessionTools: async () => ({ tools: [] }),
          });
          const result = await execute({
            name: "setActiveDevice",
            args: { deviceId: device.deviceId },
            progressToken: undefined,
            progress: undefined,
            extra: { signal: new AbortController().signal, sendNotification: async () => {} },
          });
          expect(result.isError).not.toBe(true);
        }
      },
    );
    expect(receivedIds).toEqual([undefined, undefined]);
    expect(readiness.getExplicitDevicePin("client-a")).toEqual(deviceA);
    expect(readiness.getExplicitDevicePin("client-b")).toEqual(deviceB);
    expect(readiness.getExplicitDevicePin()).toBeUndefined();
  } finally {
    bindings.dispose();
  }
});
