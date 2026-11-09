import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { prototypeSchema } from "../../src/server/prototypeTools/schemas";
import { registerPrototypeTools } from "../../src/server/prototypeTools/registration";
import type {
  PrototypeToolDependencies,
  PrototypeToolRuntime,
  PrototypeToolRuntimeModule,
} from "../../src/server/prototypeTools/types";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { LazyFeatureModule } from "../../src/utils/lazyFeatureModule";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { PROTOTYPE_SHOW_IN_PLACE_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeOutputSchema } from "../../src/server/prototypeTools/schemas";
import { lazyFeatureModule } from "../../src/utils/lazyFeatureModule";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
import { event } from "../helpers/prototypeTestEvent";
import { toolStructured } from "../helpers/toolResponse";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

/** A runtime module whose import the test settles; records the runtimes it builds. */
class FakeRuntimeModule implements LazyFeatureModule<PrototypeToolRuntimeModule> {
  loads = 0;
  readonly built: Array<{ dependencies?: PrototypeToolDependencies; disposed: number }> = [];
  readonly calls: unknown[] = [];
  private module: PrototypeToolRuntimeModule | undefined;
  private settle: (() => void) | undefined;

  private readonly runtimeModule: PrototypeToolRuntimeModule = {
    createPrototypeToolRuntime: (dependencies) => {
      const record = { dependencies, disposed: 0 };
      this.built.push(record);
      const runtime: PrototypeToolRuntime = {
        handler: async (_device, input) => {
          this.calls.push(input);
          return { content: [{ type: "text", text: "ok" }] };
        },
        dispose: () => {
          record.disposed++;
        },
      };
      return runtime;
    },
    daemonPrototypeShownSpecs: () => undefined,
  };

  private pending: Promise<PrototypeToolRuntimeModule> | undefined;

  /** Memoized like the real module: concurrent first calls share one import. */
  load(): Promise<PrototypeToolRuntimeModule> {
    this.loads++;
    this.pending ??= new Promise((resolve) => {
      this.settle = () => {
        this.module = this.runtimeModule;
        resolve(this.runtimeModule);
      };
    });
    return this.pending;
  }

  loaded(): PrototypeToolRuntimeModule | undefined {
    return this.module;
  }

  finishImport(): void {
    this.settle?.();
  }

  preload(): void {
    this.module = this.runtimeModule;
  }
}

describe("prototype tool runtime loads on first use (#17709)", () => {
  let restore: () => void;
  let module: FakeRuntimeModule;
  // The real runtime's import is a one-time process cost, not part of any test's budget; a fresh
  // lazyFeatureModule wrapper below is still unloaded and settles from the warm module cache.
  beforeAll(async () => {
    await import("../../src/server/prototypeTools/runtime");
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    module = new FakeRuntimeModule();
  });
  afterEach(() => restore());

  const handler = () => ToolRegistry.getTool("prototype")!.deviceAwareHandler!;

  test("registers the full schema without importing the runtime", () => {
    const dispose = registerPrototypeTools({}, module);
    const tool = ToolRegistry.getTool("prototype");
    expect(tool?.schema).toBe(prototypeSchema);
    expect(module.loads).toBe(0);
    expect(module.built).toEqual([]);
    dispose();
  });

  test("the first call imports the runtime once and later calls reuse it", async () => {
    const dependencies: PrototypeToolDependencies = { env: {} };
    const dispose = registerPrototypeTools(dependencies, module);
    const first = handler()(device, { action: "status" });
    const second = handler()(device, { action: "status", id: "b" });
    expect(module.loads).toBe(2);
    module.finishImport();
    await Promise.all([first, second]);
    await handler()(device, { action: "status", id: "c" });
    expect(module.built).toHaveLength(1);
    expect(module.built[0]?.dependencies).toBe(dependencies);
    expect(module.calls).toHaveLength(3);
    dispose();
    expect(module.built[0]?.disposed).toBe(1);
  });

  test("once the module is loaded, a registration builds its runtime at once", () => {
    module.preload();
    const dispose = registerPrototypeTools({}, module);
    expect(module.built).toHaveLength(1);
    expect(module.loads).toBe(0);
    dispose();
    expect(module.built[0]?.disposed).toBe(1);
  });

  test("a registration disposed before its first call never builds a runtime", async () => {
    const dispose = registerPrototypeTools({}, module);
    dispose();
    await expect(handler()(device, { action: "status" })).rejects.toThrow(
      "The prototype tool registration was disposed.",
    );
    expect(module.loads).toBe(0);
    expect(module.built).toEqual([]);
  });

  test("a registration disposed while its first call awaits the import never builds a runtime", async () => {
    const dispose = registerPrototypeTools({}, module);
    const call = handler()(device, { action: "status" });
    dispose();
    module.finishImport();
    await expect(call).rejects.toThrow("The prototype tool registration was disposed.");
    expect(module.built).toEqual([]);
    expect(module.calls).toEqual([]);
  });

  test("registrations made before the import are built in registration order", async () => {
    const disposeOlder = registerPrototypeTools({ env: { connection: "older" } }, module);
    const olderHandler = handler();
    const disposeNewer = registerPrototypeTools({ env: { connection: "newer" } }, module);
    const call = olderHandler(device, { action: "status" });
    module.finishImport();
    await call;
    expect(module.built.map((record) => record.dependencies?.env?.connection)).toEqual([
      "older",
      "newer",
    ]);
    disposeOlder();
    expect(module.built.map((record) => record.disposed)).toEqual([1, 0]);
    disposeNewer();
  });

  test("closing an older connection keeps the newer one's shared state when the older made the first call", async () => {
    const timer = new FakeTimer();
    const client = new FakeCtrlProxy(timer);
    client.setSupportedCommands([PROTOTYPE_SHOW_IN_PLACE_CAPABILITY]);
    const connection = {
      clientFactory: () => client,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    };
    // A fresh, not yet loaded wrapper around the real runtime module.
    const realRuntime = lazyFeatureModule(
      "prototype",
      () => import("../../src/server/prototypeTools/runtime"),
      { log: { info: () => undefined, warn: () => undefined } },
    );
    const disposeOlder = registerPrototypeTools(connection, realRuntime);
    const olderHandler = handler();
    const disposeNewer = registerPrototypeTools(connection, realRuntime);
    const shown = {
      id: "panel",
      window: { placement: { type: "fullscreen" } },
      root: { type: "text", text: "Hello" },
    };
    await olderHandler(device, { action: "show", spec: shown, sessionUuid: "one" });
    client.emitPrototypeEvent(event(1, "panel", "emit", "save"));
    disposeOlder();
    const status = prototypeOutputSchema.parse(
      toolStructured(await handler()(device, { action: "status", sessionUuid: "one" })),
    );
    expect(status.prototypes).toEqual([
      expect.objectContaining({ id: "panel", lastAction: "show", pendingCount: 1 }),
    ]);
    disposeNewer();
  });
});
