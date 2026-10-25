import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import type { GestureStartRequest } from "../../src/features/observe/android/CtrlProxyGestures";
import { spyOn } from "bun:test";
import {
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
} from "../../src/daemon/wire/constants";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import type { DeviceObservationAccess } from "../../src/server/deviceObservationAccess";
import { executionTracker } from "../../src/daemon/executionTracker";
import { combineRequestAbortSignals } from "../../src/utils/AbortContext";
import { withAdmittedSessionEcho } from "../../src/server/routedSessionEcho";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { serverConfig } from "../../src/utils/ServerConfig";
import { registerDatabaseTools } from "../../src/server/databaseTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry, type AuditRunnerInput } from "../../src/server/toolRegistry";
import { setActiveDeviceSchema } from "../../src/server/utilityTools";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
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
 * entry runs them, so a tool call's start, end and request deadline reach the daemon wiring the
 * harness subscribes (`subscribeToolCallEndActivity`, the release vetoes' deadline lookup). Only
 * the device boundary is fake: device discovery and readiness ({@link FakeDeviceReadiness}),
 * display inventory, CtrlProxy, and the handler's device work (the audit runner, which runs
 * {@link DeviceToolBody} instead of the handler).
 *
 * `ToolRegistry` reads `DaemonState.getInstance()`, so the harness must initialize it with its
 * daemon's session manager and pool.
 */
export class RealToolCallPath {
  readonly deviceReadiness = new FakeDeviceReadiness();
  /** Tool bodies that reached the device boundary, in order. */
  readonly runs: DeviceToolRun[] = [];
  /**
   * Executions the daemon cancelled while they were in flight (the expiry canceller, a release
   * that cuts its calls), in order. A request the transport gave up on is not one of these.
   */
  readonly cancelledExecutions: Array<{ name: string; sessionUuid: string | undefined }> = [];
  /** Writes a socket `ide/*` frame sent to the device through CtrlProxy (the device boundary). */
  readonly ctrlProxyWrites: string[] = [];
  /** Streamed-gesture frames CtrlProxy received, as `<start|move|end|cancel>:<gestureId>`. */
  readonly gestureFrames: string[] = [];
  /** Devices the read-only (watcher) path resolved from the booted list (#10830). */
  watcherResolutions = 0;
  /** Devices whose observer capture the read-only path ran (the handler's `executeDeviceRead`). */
  readonly watcherReads: string[] = [];
  /** The watcher path lists booted devices itself; never reach adb from a unit test. */
  private readonly deviceReadAccess: DeviceObservationAccess = {
    listBooted: async () => {
      this.watcherResolutions++;
      return this.devices;
    },
    isAuthorized: () => true,
  };
  private body: DeviceToolBody = async () => SUCCESS;
  private readonly restorers: Array<() => void> = [];

  constructor(private readonly devices: BootedDevice[]) {
    this.deviceReadiness.setConnectedDevices(devices);
  }

  install(registerDefaultTools = true): this {
    ToolRegistry.clearTools();
    this.restorers.push(
      ToolRegistry.setPipelineOverridesForTesting({
        displayInventory: new FakeDisplayInventoryProvider(),
        deviceReadAccess: this.deviceReadAccess,
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
    const originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    this.restorers.push(() => ToolRegistry.setCollaboratorsForTesting(originalCollaborators));
    ToolRegistry.setCollaboratorsForTesting({
      deviceReadiness: this.deviceReadiness,
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
      navigationToolCallRecorder: { record: () => undefined },
    });
    const proxy = new FakeCtrlProxy(new FakeTimer());
    proxy.bindSession = () => undefined;
    proxy.getScreenScaleMetadata = () => null;
    proxy.requestTapCoordinates = async (
      ...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>
    ) => {
      args[0].onDispatch?.();
      return { success: true, totalTimeMs: 0 };
    };
    proxy.setPreference = async (...args: Parameters<AndroidCtrlProxyClient["setPreference"]>) => {
      if (typeof args[5] === "object") {
        args[5].onDispatch?.();
      }
      this.ctrlProxyWrites.push("setPreference");
    };
    proxy.requestGestureStart = async (request: GestureStartRequest) => {
      const { gestureId } = request;

      this.gestureFrames.push(`start:${gestureId}`);
      return { success: true, totalTimeMs: 0 };
    };
    proxy.requestGestureMove = async (gestureId: string) => {
      this.gestureFrames.push(`move:${gestureId}`);
      return { success: true, totalTimeMs: 0 };
    };
    proxy.requestGestureEnd = async (gestureId: string, _x: number, _y: number, cancel = false) => {
      this.gestureFrames.push(`${cancel ? "cancel" : "end"}:${gestureId}`);
      return { success: true, totalTimeMs: 0 };
    };
    const ctrlProxy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(proxy);
    this.restorers.push(() => ctrlProxy.mockRestore());
    // Focused admission suites register their own tool and keep the real pipeline above.
    if (!registerDefaultTools) {
      return this;
    }
    registerInteractionTools();
    // sqlQuery is an embedded-SDK tool: it is only reachable when that mode is on.
    const embeddedSdk = serverConfig.isEmbeddedSdkEnabled();
    serverConfig.setEmbeddedSdkEnabled(true);
    this.restorers.push(() => serverConfig.setEmbeddedSdkEnabled(embeddedSdk));
    registerDatabaseTools();
    // The read-only path's capture is the one device-boundary call the handler makes itself (the
    // audit runner does not wrap it): a fake screen stands in for the observer's hierarchy service.
    registerObserveTools({
      deviceReadAccess: this.deviceReadAccess,
      createScreen: (device) => ({
        executeDeviceRead: async () => {
          this.watcherReads.push(device.deviceId);
          return loadAndroidHomeObserve().observe;
        },
        execute: async () => {
          throw new Error("RealToolCallPath: the session observe pipeline is not faked");
        },
        appendRawViewHierarchy: async () => {},
        getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
        captureScreenshot: async () => {
          throw new Error("RealToolCallPath: screenshots are not faked");
        },
      }),
    });
    // The real handler and registration; only the CtrlProxy resume at the device boundary is fake.
    ToolRegistry.register(
      "setActiveDevice",
      "Set active device",
      setActiveDeviceSchema,
      createSetActiveDeviceHandler({
        displayInventory: new FakeDisplayInventoryProvider(),
        resumeCtrlProxy: async () => undefined,
        legacyDeviceSelection: () => this.deviceReadiness,
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
   * `requestSignal` is the MCP request's own signal: the entry hands the handler that and the
   * execution's signal combined, so a request the transport gave up on stops its handler.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new Error(`RealToolCallPath: tool ${name} is not registered`);
    }
    const sessionUuid = typeof args.sessionUuid === "string" ? args.sessionUuid : undefined;
    const execution = executionTracker.startExecution(name, undefined, sessionUuid);
    // The entry records the absolute deadline the socket server stamped on the forwarded call, so
    // a release this call vetoes is bounded by the call's own deadline (#10712).
    const requestDeadlineMs = args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
    executionTracker.setExecutionDeadline(execution.id, () =>
      typeof requestDeadlineMs === "number" ? requestDeadlineMs : undefined,
    );
    execution.abortController.signal.addEventListener(
      "abort",
      () => this.cancelledExecutions.push({ name, sessionUuid }),
      { once: true },
    );
    try {
      const result = await tool.handler(
        {
          ...args,
          [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
          [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
        },
        undefined,
        combineRequestAbortSignals(execution.abortController.signal, requestSignal),
      );
      // The daemon's tool-call entry echoes the session the call was admitted under (#10974).
      return withAdmittedSessionEcho(result, execution.id);
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
