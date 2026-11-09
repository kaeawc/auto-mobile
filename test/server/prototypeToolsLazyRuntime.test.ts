import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
});
