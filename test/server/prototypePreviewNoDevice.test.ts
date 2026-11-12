import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrototypePreviewServer } from "../../src/features/prototype/preview/PrototypePreviewServer";
import { revisionPreviewPageSource } from "../../src/features/prototype/preview/prototypePreviewSource";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import { ActionableError } from "../../src/models/ActionableError";
import type { ExecutionTargetResolver } from "../../src/server/pipeline/executionTarget";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakePreviewHttpBinder } from "../features/prototype/preview/previewFakes";
import { readToolResponse } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const NO_DEVICE = "No device available";

/** Mirrors the resolver's contract: `shouldEnsureDevice` decides whether a device is resolved. */
const noDeviceResolver: ExecutionTargetResolver = {
  async resolveExecutionTarget({ args, options }) {
    if (options.shouldEnsureDevice?.(args) ?? true) {
      throw new ActionableError(NO_DEVICE);
    }
    return {
      args,
      device: undefined,
      baseSessionUuid: undefined,
      sessionUuid: undefined,
      internalCall: false,
      shouldResolveDevice: false,
    };
  },
};

/** serve and stop are host-only: no device is resolved for them outside headless mode (#18083). */
describe("prototype preview with no device available", () => {
  let restoreRegistry: () => void;
  let restorePipeline: () => void;
  let restoreRepository: () => void;
  let dispose: () => void;
  let http: FakePreviewHttpBinder;

  beforeEach(() => {
    restoreRegistry = preserveToolRegistry();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: noDeviceResolver,
      afterToolCall: {
        async handle({ response }) {
          return { durationMs: 0, finalizedResponse: response };
        },
      },
      planLifecycleManager: { async afterExecution() {} },
    });
    const repository = ToolRegistry.getCollaboratorsForTesting().toolCallRepository;
    restoreRepository = () => ToolRegistry.setToolCallRepositoryForTesting(repository);
    ToolRegistry.setToolCallRepositoryForTesting({ async recordToolCall() {} });
    const timer = new FakeTimer();
    http = new FakePreviewHttpBinder();
    const revisions = new PrototypeSpecRevisions(timer);
    const source = revisionPreviewPageSource(revisions, async ({ id }) => `<page ${id}>`);
    dispose = registerPrototypeTools({
      env: {},
      store: new InMemoryPrototypeStatusStore(timer, undefined, revisions),
      clock: timer,
      timer,
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
      preview: { server: new PrototypePreviewServer({ source, http, timer }), source },
    });
  });
  afterEach(() => {
    dispose();
    restorePipeline();
    restoreRepository();
    restoreRegistry();
  });

  const call = async (input: Record<string, unknown>) =>
    prototypeOutputSchema.parse(
      readToolResponse(await ToolRegistry.getTool("prototype")!.handler(input)).structuredContent,
    );

  test("serve and stop succeed through the registered handler", async () => {
    const served = await call({ action: "serve", port: 8765 });
    expect(served).toMatchObject({
      success: true,
      previewServer: { running: true, url: "http://127.0.0.1:8765/" },
    });
    // Not headless: the result is not attributed to the virtual device.
    expect(served.virtualDevice).toBeUndefined();
    const stopped = await call({ action: "stop" });
    expect(stopped).toMatchObject({ success: true, previewServer: { running: false } });
    expect(http.closed).toBe(1);
  });

  test("screenMap needs no device either", async () => {
    const mapped = await call({
      action: "screenMap",
      spec: {
        id: "map",
        window: { placement: { type: "fullscreen" } },
        root: { type: "text", text: "Hi" },
      },
    });
    expect(mapped.error).toBeUndefined();
    expect(mapped.success).toBe(true);
    expect(mapped.virtualDevice).toBeUndefined();
  });

  test("a device action still resolves a device", async () => {
    await expect(
      call({ action: "show", spec: { id: "cart", root: { type: "text", text: "Cart" } } }),
    ).rejects.toThrow(NO_DEVICE);
  });
});
