import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readToolResponse } from "../helpers/toolResponse";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { prototypeScreenShapeOutput } from "../../src/server/prototypeTools/screenShape";
import type { ScreenRoundReader } from "../../src/features/wear/screenRound";
import type { PrototypeSpec } from "../../src/features/prototype/prototypeSpec";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const watch: BootedDevice = {
  deviceId: "emulator-5560",
  platform: "android",
  name: "Wear Round",
  formFactor: "watch",
};
const phone: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const ios: BootedDevice = {
  deviceId: "sim-1",
  platform: "ios",
  name: "iPhone",
  formFactor: "phone",
};

const spec: PrototypeSpec = {
  id: "card",
  window: { placement: { type: "fullscreen" }, opacity: 1 },
  root: { type: "text", text: "Hello" },
};

/** Answers a fixed shape and records which devices were asked. */
class FakeScreenRound implements ScreenRoundReader {
  constructor(
    private readonly deviceId: string,
    private readonly round: boolean | undefined,
    private readonly log: string[],
  ) {}
  async isScreenRound(): Promise<boolean | undefined> {
    this.log.push(this.deviceId);
    return this.round;
  }
}

function factory(round: boolean | undefined) {
  const asked: string[] = [];
  return {
    asked,
    screenRoundFactory: (device: BootedDevice) =>
      new FakeScreenRound(device.deviceId, round, asked),
  };
}

describe("prototypeScreenShapeOutput", () => {
  test.each([true, false])(
    "device-reported %s skips both reader and ADB factories",
    async (round) => {
      const { asked, screenRoundFactory } = factory(!round);
      const adbFactory = new FakeAdbClientFactory();
      expect(
        await prototypeScreenShapeOutput(
          { action: "show", success: true, device: watch, deviceScreenRound: round },
          { screenRoundFactory, adbFactory },
        ),
      ).toEqual({ screenRound: round });
      expect(asked).toEqual([]);
      expect(adbFactory.getCallCount()).toBe(0);
    },
  );

  test("absent device shape falls back to the ADB reader", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell dumpsys display",
      createExecResult("DisplayInfo{displayId 0, FLAG_ROUND}", ""),
    );
    const adbFactory = new FakeAdbClientFactory(adb);
    expect(
      await prototypeScreenShapeOutput(
        { action: "show", success: true, device: watch },
        { adbFactory },
      ),
    ).toEqual({ screenRound: true });
    expect(adbFactory.getCalls().map(({ device }) => device?.deviceId)).toEqual([watch.deviceId]);
    expect(adb.getExecutedCommands()).toEqual(["shell dumpsys display"]);
  });

  test("a successful show on a round watch reports screenRound", async () => {
    const { asked, screenRoundFactory } = factory(true);
    const output = await prototypeScreenShapeOutput(
      { action: "show", success: true, device: watch },
      { screenRoundFactory },
    );
    expect(output).toEqual({ screenRound: true });
    expect(asked).toEqual(["emulator-5560"]);
  });

  test("a square watch reports false", async () => {
    const { screenRoundFactory } = factory(false);
    const output = await prototypeScreenShapeOutput(
      { action: "show", success: true, device: watch },
      { screenRoundFactory },
    );
    expect(output).toEqual({ screenRound: false });
  });

  test("an unreadable display leaves the field absent", async () => {
    const { screenRoundFactory } = factory(undefined);
    const output = await prototypeScreenShapeOutput(
      { action: "show", success: true, device: watch },
      { screenRoundFactory },
    );
    expect(output).toStrictEqual({});
  });

  test("phones, iOS, failed shows and other actions pay no read", async () => {
    const { asked, screenRoundFactory } = factory(true);
    const adbFactory = new FakeAdbClientFactory();
    const cases = [
      { action: "show", success: true, device: phone },
      { action: "show", success: true, device: ios },
      { action: "show", success: false, device: watch },
      { action: "dismiss", success: true, device: watch },
    ];
    for (const input of cases) {
      expect(
        await prototypeScreenShapeOutput(
          { ...input, deviceScreenRound: true },
          { screenRoundFactory, adbFactory },
        ),
      ).toStrictEqual({});
    }
    expect(asked).toEqual([]);
    expect(adbFactory.getCallCount()).toBe(0);
  });
});

describe("prototype tool screenRound", () => {
  let restore: () => void;
  let unsubscribe: () => void;
  let asked: string[];
  let client: FakeCtrlProxy;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    const fake = factory(true);
    asked = fake.asked;
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      screenRoundFactory: fake.screenRoundFactory,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function show(device: BootedDevice) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, {
      action: "show",
      spec,
    });
    return readToolResponse(response).structuredContent as Record<string, unknown>;
  }

  test("a watch show carries screenRound and matches the output schema", async () => {
    const output = await show(watch);
    expect(output.success).toBe(true);
    expect(output.screenRound).toBe(true);
    expect(prototypeOutputSchema.safeParse(output).success).toBe(true);
    expect(asked).toEqual(["emulator-5560"]);
  });

  test.each([true, false])(
    "watch show forwards device-reported %s without a fallback read",
    async (round) => {
      client.setPrototypeResult({ success: true, screenRound: round });
      const output = await show(watch);
      expect(output.success).toBe(true);
      expect(output.screenRound).toBe(round);
      expect(prototypeOutputSchema.safeParse(output).success).toBe(true);
      expect(asked).toEqual([]);
    },
  );

  test("a phone show has no screenRound", async () => {
    client.setPrototypeResult({ success: true, screenRound: true });
    const output = await show(phone);
    expect(output.success).toBe(true);
    expect(output).not.toHaveProperty("screenRound");
    expect(asked).toEqual([]);
  });
});
