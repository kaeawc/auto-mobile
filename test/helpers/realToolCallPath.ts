import { spyOn } from "bun:test";
import {
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
} from "../../src/daemon/constants";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/server/executionTracker";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry, type AuditRunnerInput } from "../../src/server/toolRegistry";
import { setActiveDeviceSchema } from "../../src/server/utilityTools";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

/** One device tool body that reached the device boundary. */
export interface DeviceToolRun {
  name: string;
  deviceId: string;
  sessionUuid: string | undefined;
}

/** What a tool body does at the device boundary; it stands in for the handler's device work. */
export type DeviceToolBody = (input: AuditRunnerInput) => Promise<unknown>;

const SUCCESS = { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };

/**
 * The production device-tool path for daemon harnesses (#10839): the real `rotate`/`observe`/...
 * registrations, the real `ToolRegistry` target resolution (ownership refusal, session admission,
 * `createToolExecutionContext`), and the execution tracker run exactly as the daemon's tool-call
 * entry runs them, so a tool call's start and end reach the daemon wiring the harness subscribes
 * (`subscribeToolCallEndActivity`). Only the device boundary is fake: device discovery and
 * readiness ({@link FakeDeviceSessionManager}), display inventory, CtrlProxy, and the handler's
 * device work (the audit runner, which runs {@link DeviceToolBody} instead of the handler).
 *
 * `ToolRegistry` reads `DaemonState.getInstance()`, so the harness must initialize it with its
 * daemon's session manager and pool.
 */
export class RealToolCallPath {
  readonly deviceSessionManager = new FakeDeviceSessionManager();
  /** Tool bodies that reached the device boundary, in order. */
  readonly runs: DeviceToolRun[] = [];
  private body: DeviceToolBody = async () => SUCCESS;
  private readonly restorers: Array<() => void> = [];

  constructor(devices: BootedDevice[]) {
    this.deviceSessionManager.setConnectedDevices(devices);
  }

  install(): this {
    ToolRegistry.clearTools();
    this.restorers.push(
      ToolRegistry.setPipelineOverridesForTesting({
        displayInventory: new FakeDisplayInventoryProvider(),
        auditRunner: {
          run: async (input: AuditRunnerInput) => {
            this.runs.push({
              name: input.name,
              deviceId: input.device.deviceId,
              sessionUuid: input.args?.sessionUuid,
            });
            return await this.body(input);
          },
        },
        afterToolCall: {
          async handle(input) {
            return { durationMs: 0, finalizedResponse: input.response };
          },
        },
      }),
    );
    for (const [field, fake] of [
      ["deviceSessionManager", this.deviceSessionManager],
      ["toolCallRepository", { async recordToolCall(): Promise<void> {} }],
      ["navigationToolCallRecorder", { record: () => undefined }],
    ] as const) {
      const original = Reflect.get(ToolRegistry, field);
      Reflect.set(ToolRegistry, field, fake);
      this.restorers.push(() => Reflect.set(ToolRegistry, field, original));
    }
    const ctrlProxy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          bindSession: () => undefined,
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: async () => ({ success: true }),
        }) as unknown as AndroidCtrlProxyClient,
    );
    this.restorers.push(() => ctrlProxy.mockRestore());
    registerInteractionTools();
    registerObserveTools();
    // The real handler and registration; only the CtrlProxy resume at the device boundary is fake.
    ToolRegistry.register(
      "setActiveDevice",
      "Set active device",
      setActiveDeviceSchema,
      createSetActiveDeviceHandler({
        displayInventory: new FakeDisplayInventoryProvider(),
        resumeCtrlProxy: async () => undefined,
      }),
      { defaultEnabled: true },
    );
    return this;
  }

  /** Replace what a tool body does at the device boundary (e.g. stay in flight until released). */
  setBody(body: DeviceToolBody): void {
    this.body = body;
  }

  /**
   * One `tools/call` as the daemon's tool-call entry runs it: a tracked execution under the
   * call's `sessionUuid`, the registered handler, and the execution's end. Resolves with the
   * handler's result or rejects with what it threw, as the MCP server's catch block receives it.
   */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new Error(`RealToolCallPath: tool ${name} is not registered`);
    }
    const sessionUuid = typeof args.sessionUuid === "string" ? args.sessionUuid : undefined;
    const execution = executionTracker.startExecution(name, undefined, sessionUuid);
    try {
      return await tool.handler(
        {
          ...args,
          [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
          [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
        },
        undefined,
        execution.abortController.signal,
      );
    } finally {
      executionTracker.endExecution(execution.id);
    }
  }

  uninstall(): void {
    ToolRegistry.clearTools();
    for (const restore of this.restorers.splice(0).reverse()) {
      restore();
    }
  }
}
