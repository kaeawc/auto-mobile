import { readToolEnvelopePayload } from "../../../src/utils/toolEnvelopePayload";
import { afterEach, describe, expect, test } from "bun:test";
import {
  PROTOTYPE_APPEARANCE_CAPABILITY,
  PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import type { BootedDevice } from "../../../src/models";
import { prototypeOutputSchema, registerPrototypeTools } from "../../../src/server/prototypeTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../../fakes/FakePrototypeAgentClient";
import { FakePrototypeAssetFileReader } from "../../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../../fakes/FakeTimer";
import { preserveToolRegistry } from "../../helpers/withTemporaryTool";

/**
 * #11416 item 2. The owner contract: the host refuses an unsupported capability form before any
 * device side effect. Every show form crossed with every appearance value and each platform's
 * capability state goes through the real tool handler with fake device transports; a refusal must
 * leave the transport with zero writes (shows, asset uploads, adb commands) and no host presence.
 */
const android: BootedDevice = { deviceId: "refusal-android", platform: "android", name: "A" };
const ios: BootedDevice = { deviceId: "refusal-ios", platform: "ios", name: "I" };
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const }, opacity: 1 },
  root: { type: "text" as const, text: "Hello" },
};
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);

const FORMS = [
  ["fresh show", false, {}],
  ["in-place show", true, {}],
  ["reset show", true, { reset: true }],
  ["show with assets", false, { assets: [{ id: "logo", path: "/img/logo.png" }] }],
] as const;
const APPEARANCES = ["light", "dark", "device", undefined] as const;

describe("appearance override refusals happen before any device write (#11416)", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let adb: FakeAdbExecutor;
  let restore: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  function register(agentCapabilities: readonly string[]) {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    adb = new FakeAdbExecutor();
    client = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...agentCapabilities],
    });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: (deviceId) => (deviceId === ios.deviceId ? agent : undefined) },
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      assetFileReader: new FakePrototypeAssetFileReader().addFile("/img/logo.png", png),
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  function tearDown() {
    unsubscribe?.();
    restore?.();
    unsubscribe = undefined;
    restore = undefined;
  }
  afterEach(tearDown);

  async function call(device: BootedDevice, input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(readToolEnvelopePayload(response)?.payload);
  }
  const show = (device: BootedDevice, extra: Record<string, unknown>) =>
    call(device, { action: "show", spec, ...extra });

  /** Everything the device could have been asked to do so far. */
  const writes = (device: BootedDevice) =>
    JSON.stringify(
      device.platform === "android"
        ? [
            client.getPrototypeHistory(),
            client.getPrototypeAssetHistory(),
            adb.getExecutedCommands(),
          ]
        : [agent.requests],
    );

  describe.each(["android", "ios"] as const)("%s", (platform) => {
    const device = platform === "android" ? android : ios;
    const setUp = (supported: boolean) => {
      register(
        platform === "ios" && supported
          ? [...FAKE_PROTOTYPE_AGENT_CAPABILITIES, PROTOTYPE_APPEARANCE_CAPABILITY]
          : FAKE_PROTOTYPE_AGENT_CAPABILITIES,
      );
      client.setSupportedCommands(supported ? [PROTOTYPE_APPEARANCE_CAPABILITY] : []);
    };

    describe.each([
      ["capability advertised", true],
      ["capability not advertised", false],
    ] as const)("%s", (_state, supported) => {
      describe.each(FORMS)("%s", (_form, needsPriorShow, extra) => {
        test.each([...APPEARANCES])("appearance %p", async (appearance) => {
          setUp(supported);
          if (needsPriorShow) {
            expect((await show(device, {})).success).toBe(true);
          }
          const before = writes(device);

          const result = await show(device, { ...extra, ...(appearance ? { appearance } : {}) });

          const pinned = appearance === "light" || appearance === "dark";
          if (pinned && !supported) {
            expect(result.success).toBe(false);
            expect(result.error).toContain(
              platform === "android"
                ? `connected CtrlProxy does not advertise ${PROTOTYPE_APPEARANCE_CAPABILITY}`
                : `connected iOS prototype agent does not advertise ${PROTOTYPE_APPEARANCE_CAPABILITY}`,
            );
            expect(result.error).toContain(`appearance "${appearance}"`);
            expect(result.error).toContain("Nothing was shown.");
            expect(result.uploadedAssets).toBeUndefined();
            expect(writes(device)).toBe(before);
            const status = await call(device, { action: "status" });
            expect(status.prototypes?.length ?? 0).toBe(needsPriorShow ? 1 : 0);
          } else {
            expect(result.success).toBe(true);
            expect(writes(device)).not.toBe(before);
          }
        });
      });
    });
  });

  describe("iOS reset on an agent without in-place shows", () => {
    test.each([
      ["appearance advertised", [PROTOTYPE_APPEARANCE_CAPABILITY]],
      ["appearance not advertised either", []],
    ] as const)("a pinned reset show is refused with zero writes, %s", async (_name, extra) => {
      register([
        ...FAKE_PROTOTYPE_AGENT_CAPABILITIES.filter(
          (name) => name !== PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
        ),
        ...extra,
      ]);
      expect((await show(ios, {})).success).toBe(true);
      const before = writes(ios);

      const result = await show(ios, { reset: true, appearance: "dark" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Nothing was shown.");
      expect(writes(ios)).toBe(before);
    });
  });
});
