import { expect, test } from "bun:test";
import {
  runWithToolSelectionContext,
  type ToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";

const deviceA = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" } as const;
const deviceB = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" } as const;

function harness() {
  const readiness = new FakeDeviceReadiness();
  readiness.setConnectedDevices([deviceA, deviceB]);
  const select = createSetActiveDeviceHandler({
    legacyDeviceSelection: () => readiness,
    resumeCtrlProxy: async () => {},
  });
  return { readiness, select };
}

test("header-keyed clients retain separate device pins without touching direct-stdio", async () => {
  const { readiness, select } = harness();
  await runWithToolSelectionContext({ deviceConnectionKey: "client-a" }, () =>
    select({ deviceId: deviceA.deviceId }),
  );
  expect(readiness.getLastOptions()?.connectionId).toBe("client-a");
  await runWithToolSelectionContext({ deviceConnectionKey: "client-b" }, () =>
    select({ deviceId: deviceB.deviceId }),
  );
  expect(readiness.getLastOptions()?.connectionId).toBe("client-b");
  expect(readiness.getExplicitDevicePin("client-a")).toEqual(deviceA);
  expect(readiness.getExplicitDevicePin("client-b")).toEqual(deviceB);
  expect(readiness.getExplicitDevicePin()).toBeUndefined();
});

test.each([
  {
    name: "ambient caller",
    context: { callerMcpSessionId: "conn-x", deviceConnectionKey: "header" },
    arg: undefined,
    expected: "conn-x",
  },
  {
    name: "explicit argument",
    context: { callerMcpSessionId: "caller", deviceConnectionKey: "header" },
    arg: "explicit",
    expected: "explicit",
  },
  {
    name: "blank argument",
    context: { callerMcpSessionId: "conn-x" },
    arg: "  ",
    expected: "conn-x",
  },
  {
    name: "blank caller",
    context: { callerMcpSessionId: "  ", deviceConnectionKey: "header" },
    arg: undefined,
    expected: "header",
  },
  { name: "direct default", context: {}, arg: undefined, expected: undefined },
] satisfies Array<{
  name: string;
  context: ToolSelectionContext;
  arg: string | undefined;
  expected: string | undefined;
}>)(
  "$name determines the device pin and readiness connection",
  async ({ context, arg, expected }) => {
    const { readiness, select } = harness();
    await runWithToolSelectionContext(context, () =>
      select({ deviceId: deviceA.deviceId, __mcpSessionId: arg }),
    );
    expect(readiness.getLastOptions()?.connectionId).toBe(expected);
    expect(readiness.getExplicitDevicePin(expected)).toEqual(deviceA);
    if (expected) {
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    }
  },
);

test("nested calls with undefined device identity inherit the enclosing connection pin key", async () => {
  const { readiness, select } = harness();
  await runWithToolSelectionContext({ deviceConnectionKey: "parent" }, () =>
    runWithToolSelectionContext({ deviceConnectionKey: undefined }, () =>
      select({ deviceId: deviceA.deviceId }),
    ),
  );
  expect(readiness.getExplicitDevicePin("parent")).toEqual(deviceA);
  expect(readiness.getExplicitDevicePin()).toBeUndefined();
});
