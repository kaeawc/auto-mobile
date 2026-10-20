import { readToolResponse } from "../helpers/toolResponse";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  PROTOTYPE_WINDOW_CHROME_CAPABILITY,
  PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
  PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import { IosPrototypeTransport } from "../../src/features/prototype/ios/iosPrototypeTransport";
import { prototypeWindowChromeUnsupportedMessage } from "../../src/features/prototype/prototypeWindowChrome";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const spec = (window: Record<string, unknown> = {}) => ({
  id: "panel",
  window: { placement: { type: "fullscreen" }, ...window },
  root: { type: "text", text: "Hello" },
});
type PrototypeTools = typeof import("../../src/server/prototypeTools");
let prototypeOutputSchema: PrototypeTools["prototypeOutputSchema"];
let registerPrototypeTools: PrototypeTools["registerPrototypeTools"];
let showInput: Readonly<ReturnType<PrototypeTools["prototypeSchema"]["parse"]>>;
let olderDeviceStatus: Readonly<ReturnType<PrototypeTools["prototypeOutputSchema"]["parse"]>>;
const barLastResult = {
  id: "panel",
  lastAction: "show",
  success: true,
  chrome: "bar",
  timestamp: 0,
};
// Only shared module/schema initialization runs here. Each scenario creates its own
// fakes and registration and issues every handler call inside the test.
beforeAll(async () => {
  const tools = await import("../../src/server/prototypeTools");
  prototypeOutputSchema = tools.prototypeOutputSchema;
  registerPrototypeTools = tools.registerPrototypeTools;
  showInput = Object.freeze(tools.prototypeSchema.parse({ action: "show", spec: spec() }));
  olderDeviceStatus = Object.freeze(
    prototypeOutputSchema.parse({
      success: true,
      prototypes: [barLastResult],
      lastResult: barLastResult,
    }),
  );
});
for (const platform of ["android", "ios"] as const) {
  describe(`${platform} window chrome`, () => {
    const device: BootedDevice = { deviceId: `fake-chrome-${platform}`, platform, name: "Fake" };
    let client: FakeCtrlProxy;
    let agent: FakePrototypeAgentClient;
    let adb: FakeAdbExecutor;
    let assetReader: FakePrototypeAssetFileReader;
    let restore: () => void;
    let unsubscribe: () => void;
    beforeEach(() => {
      restore = preserveToolRegistry();
      const timer = new FakeTimer();
      client = new FakeCtrlProxy(timer);
      client.setSupportedCommands([]);
      agent = new FakePrototypeAgentClient({
        agentVersion: "0.1.0",
        protocolVersion: 1,
        capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES],
      });
      adb = new FakeAdbExecutor();
      assetReader = new FakePrototypeAssetFileReader().addFile(
        "/img/logo.png",
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(4),
        ]),
      );
      unsubscribe = registerPrototypeTools({
        clientFactory: () => client,
        agentConnections: { get: () => agent },
        adbFactory: new FakeAdbClientFactory(adb),
        assetFileReader: assetReader,
        cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
        lastRenderedObservation: () => undefined,
        clock: timer,
        timer,
      });
    });
    afterEach(() => {
      unsubscribe();
      restore();
    });
    async function call(input: Record<string, unknown>) {
      const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
      return prototypeOutputSchema.parse(readToolResponse(response).structuredContent);
    }
    const show = (window?: Record<string, unknown>) =>
      call(window === undefined ? showInput : { ...showInput, spec: spec(window) });
    const shows = () =>
      platform === "android"
        ? client
            .getPrototypeHistory()
            .filter((entry) => entry.method === "show")
            .map((entry) => entry.spec)
        : agent.requests
            .filter((entry) => entry.type === "show_prototype")
            .map((entry) => entry.body.spec);
    const support = () => {
      client.setSupportedCommands([
        PROTOTYPE_WINDOW_CHROME_CAPABILITY,
        PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
      ]);
      agent.handshake.capabilities.push(PROTOTYPE_WINDOW_CHROME_CAPABILITY);
    };
    test("explicit none on an older device records a refusal and keeps the shown prototype", async () => {
      await show();
      const before = await call({ action: "status" });
      expect(before).toMatchObject(olderDeviceStatus);
      const refused = await show({ chrome: "none" });
      expect(refused.success).toBe(false);
      expect(refused.error).toContain("prototype_window_chrome_v1");
      expect(refused.error).toContain(
        platform === "ios" ? "launchApp prototype: true" : "Update the connected CtrlProxy",
      );
      expect(refused.error).toBe(prototypeWindowChromeUnsupportedMessage(platform));
      expect(refused.lastResult).toEqual({
        id: "panel",
        lastAction: "show",
        success: false,
        error: refused.error,
        timestamp: 0,
      });
      expect(refused).not.toHaveProperty("lastResult.chrome");
      expect(shows()).toEqual([spec()]);
      const status = await call({ action: "status" });
      expect(status.prototypes).toEqual(before.prototypes);
      expect(status.lastResult).toEqual(refused.lastResult);
      expect(adb.getExecutedCommands()).toEqual([]);
    });
    test("a chrome-refused show with assets uploads nothing", async () => {
      const refused = await call({
        action: "show",
        spec: { ...spec({ chrome: "none" }), root: { type: "image", asset: "logo" } },
        assets: [{ id: "logo", path: "/img/logo.png" }],
      });
      expect(refused.lastResult).toMatchObject({
        id: "panel",
        lastAction: "show",
        success: false,
        error: prototypeWindowChromeUnsupportedMessage(platform),
      });
      expect(refused.uploadedAssets).toBeUndefined();
      expect(assetReader.reads).toEqual([]);
      expect(client.getPrototypeAssetHistory()).toEqual([]);
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(agent.requests).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
      const status = await call({ action: "status" });
      expect(status.prototypes).toEqual([]);
    });
    test("a chrome refusal does not supersede a valid same-id show staging assets", async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const read = assetReader.readFile.bind(assetReader);
      const held = spyOn(assetReader, "readFile").mockImplementationOnce(async (path) => {
        entered.resolve();
        await release.promise;
        return read(path);
      });
      const valid = call({
        action: "show",
        spec: spec(),
        assets: [{ id: "logo", path: "/img/logo.png" }],
      });
      try {
        await entered.promise;
        const refused = await show({ chrome: "none" });
        expect(refused.lastResult).toMatchObject({
          id: "panel",
          lastAction: "show",
          success: false,
          error: prototypeWindowChromeUnsupportedMessage(platform),
        });
        expect(shows()).toEqual([]);
        expect(client.getPrototypeAssetHistory()).toEqual([]);
        expect(agent.requests).toEqual([]);
        release.resolve();
        const shown = await valid;
        expect(shown.success).toBe(true);
        expect(shown.error).toBeUndefined();
        expect(shown.lastResult?.chrome).toBe("bar");
        expect(shows()).toEqual([spec()]);
        const status = await call({ action: "status" });
        expect(status.lastResult).toEqual(shown.lastResult);
        expect(status.prototypes).toEqual([shown.lastResult!]);
      } finally {
        release.resolve();
        held.mockRestore();
        await valid;
      }
    });
    test.each([undefined, "bar"])(
      "older device shows %p unchanged and reports bar",
      async (chrome) => {
        const window = chrome ? { chrome } : {};
        const result = await show(window);
        expect(result.success).toBe(true);
        expect(result.lastResult?.chrome).toBe("bar");
        expect(shows()).toEqual([spec(window)]);
      },
    );
    test.each([undefined, "none", "bar"])(
      "capable device shows %p unchanged and reports its effective chrome",
      async (chrome) => {
        support();
        const window = chrome ? { chrome } : {};
        const lookup =
          platform === "android"
            ? spyOn(client, "supportsCommand")
            : spyOn(IosPrototypeTransport.prototype, "supportsCapability");
        try {
          const result = await show(window);
          expect(result.success).toBe(true);
          expect(result.lastResult?.chrome).toBe(chrome ?? "none");
          expect(shows()).toEqual([spec(window)]);
          expect(
            lookup.mock.calls.filter(([name]) => name === PROTOTYPE_WINDOW_CHROME_CAPABILITY),
          ).toHaveLength(1);
        } finally {
          lookup.mockRestore();
        }
        const status = await call({ action: "status" });
        expect(status.lastResult?.chrome).toBe(chrome ?? "none");
        expect(status.prototypes?.[0]?.chrome).toBe(chrome ?? "none");
        expect((await call({ action: "dismiss", id: "panel" })).lastResult).not.toHaveProperty(
          "chrome",
        );
        expect((await call({ action: "status" })).lastResult).not.toHaveProperty("chrome");
      },
    );
    if (platform === "android") {
      test.each([undefined, "none", "bar"])(
        "device persistence %p resolves its default independently",
        async (chrome) => {
          support();
          const window = { persistence: "device", ...(chrome ? { chrome } : {}) };
          expect((await show(window)).lastResult?.chrome).toBe(chrome ?? "bar");
          expect(shows()).toEqual([spec(window)]);
        },
      );
    }
    for (const placement of [
      { type: "sheet", edge: "bottom", height: 200 },
      { type: "floating", gravity: "center", offset: { x: 0, y: 0 } },
    ]) {
      test.each(["none", "bar"])(
        `${placement.type} %s refuses without a capability lookup`,
        async (chrome) => {
          const lookup =
            platform === "android"
              ? spyOn(client, "supportsCommand")
              : spyOn(IosPrototypeTransport.prototype, "supportsCapability");
          try {
            const result = await show({ placement, chrome });
            expect(result.success).toBe(false);
            expect(result.error).toContain("window.chrome applies to a fullscreen placement only");
            expect(result.lastResult).toMatchObject({
              id: "panel",
              lastAction: "show",
              success: false,
              error: result.error,
            });
            expect(lookup).not.toHaveBeenCalled();
            expect(agent.requests).toEqual([]);
            expect(shows()).toEqual([]);
            const status = await call({ action: "status" });
            expect(status.prototypes).toEqual([]);
          } finally {
            lookup.mockRestore();
          }
        },
      );
      test(`${placement.type} omitted shows without chrome`, async () => {
        expect((await show({ placement })).lastResult).not.toHaveProperty("chrome");
        expect(shows()).toEqual([spec({ placement })]);
      });
    }
    test("invalid placement keeps the shown prototype without a chrome lookup", async () => {
      await show();
      const before = await call({ action: "status" });
      const lookup =
        platform === "android"
          ? spyOn(client, "supportsCommand")
          : spyOn(IosPrototypeTransport.prototype, "supportsCapability");
      try {
        const result = await show({
          placement: { type: "sheet", edge: "bottom", height: 200 },
          chrome: "bar",
        });
        expect(result.success).toBe(false);
        expect(result.lastResult).toMatchObject({
          id: "panel",
          lastAction: "show",
          success: false,
          error: result.error,
        });
        expect(lookup.mock.calls.map(([name]) => name)).toEqual(
          platform === "android" ? [PROTOTYPE_SHOW_IN_PLACE_CAPABILITY] : [],
        );
        expect(shows()).toEqual([spec()]);
        const status = await call({ action: "status" });
        expect(status.prototypes).toEqual(before.prototypes);
        expect(status.lastResult).toEqual(result.lastResult);
      } finally {
        lookup.mockRestore();
      }
    });
    test("a superseded successful fullscreen show reports its own chrome without replacing status", async () => {
      support();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const showAndroid = client.requestShowPrototype.bind(client);
      const requestIos = agent.request.bind(agent);
      const held =
        platform === "android"
          ? spyOn(client, "requestShowPrototype").mockImplementationOnce(async (...args) => {
              const result = await showAndroid(...args);
              entered.resolve();
              await release.promise;
              return result;
            })
          : spyOn(agent, "request").mockImplementationOnce(async (...args) => {
              const result = await requestIos(...args);
              entered.resolve();
              await release.promise;
              return result;
            });
      const first = show({ chrome: "none" });
      try {
        await entered.promise;
        expect((await show({ chrome: "bar" })).lastResult?.chrome).toBe("bar");
        release.resolve();
        expect((await first).lastResult?.chrome).toBe("none");
        expect((await call({ action: "status" })).prototypes?.[0]?.chrome).toBe("bar");
      } finally {
        release.resolve();
        held.mockRestore();
        await first;
      }
    });
    test("inspect adoption carries no inferred chrome", async () => {
      support();
      await show();
      client.setSupportedCommands(["prototype_persistence_replay_v1"]);
      client.setInspectReply({
        success: true,
        prototypes: [{ id: "panel", persistent: false, state: {}, pages: {}, lastSequence: 0 }],
        droppedEvents: 0,
      });
      agent.queueReplies({
        status: { shown: true, id: "panel", state: {}, pages: {}, lastSequence: 0 },
      });
      expect((await call({ action: "inspect" })).success).toBe(true);
      expect((await call({ action: "status" })).prototypes?.[0]).not.toHaveProperty("chrome");
    });
    if (platform === "android") {
      test("an abort during the in-place lookup leaves a concurrent valid show committed", async () => {
        support();
        client.setSupportedCommands([
          PROTOTYPE_WINDOW_CHROME_CAPABILITY,
          PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
        ]);
        await show({ chrome: "bar" });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const send = client.requestShowPrototype.bind(client);
        const heldShow = spyOn(client, "requestShowPrototype").mockImplementationOnce(
          async (...args) => {
            const result = await send(...args);
            entered.resolve();
            await release.promise;
            return result;
          },
        );
        const lookupEntered = Promise.withResolvers<void>();
        const lookupRelease = Promise.withResolvers<void>();
        const controller = new AbortController();
        const supports = client.supportsCommand.bind(client);
        const valid = show({ chrome: "none" });
        let lookup: ReturnType<typeof spyOn<typeof client, "supportsCommand">> | undefined;
        let cancelled: Promise<unknown> | undefined;
        try {
          await entered.promise;
          lookup = spyOn(client, "supportsCommand").mockImplementation(async (name) => {
            if (name === PROTOTYPE_SHOW_IN_PLACE_CAPABILITY) {
              lookupEntered.resolve();
              await lookupRelease.promise;
            }
            return supports(name);
          });
          cancelled = ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
            device,
            { action: "show", spec: spec({ chrome: "bar" }) },
            undefined,
            controller.signal,
          );
          void cancelled.catch(() => undefined);
          await lookupEntered.promise;
          release.resolve();
          const shown = await valid;
          const committed = await call({ action: "status" });
          controller.abort();
          lookupRelease.resolve();
          await expect(cancelled).rejects.toThrow();
          expect(shown.success).toBe(true);
          expect(committed.lastResult).toEqual(shown.lastResult);
          expect(committed.prototypes?.[0]?.chrome).toBe("none");
          expect(await call({ action: "status" })).toEqual(committed);
          expect(shows()).toEqual([spec({ chrome: "bar" }), spec({ chrome: "none" })]);
        } finally {
          controller.abort();
          release.resolve();
          lookupRelease.resolve();
          lookup?.mockRestore();
          heldShow.mockRestore();
          await valid;
          await cancelled?.catch(() => undefined);
        }
      });
      test("abort during the chrome lookup stops the show", async () => {
        const controller = new AbortController();
        const lookup = spyOn(client, "supportsCommand").mockImplementation(async () => {
          controller.abort();
          return true;
        });
        try {
          await expect(
            ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
              device,
              { action: "show", spec: spec() },
              undefined,
              controller.signal,
            ),
          ).rejects.toThrow();
          expect(shows()).toEqual([]);
        } finally {
          lookup.mockRestore();
        }
      });
    }
    test("a device failure carries no chrome", async () => {
      support();
      client.setPrototypeResult({ success: false, error: "device refused" });
      agent.queueReplies({ success: false, error: "device refused" });
      const result = await show();
      expect(result.success).toBe(false);
      expect(result.lastResult).not.toHaveProperty("chrome");
    });
  });
}
