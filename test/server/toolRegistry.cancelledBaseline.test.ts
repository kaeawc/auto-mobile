import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DefaultAfterToolCallHandler } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { combineRequestAbortSignals } from "../../src/utils/AbortContext";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Issue #10081: a call whose request was cancelled or timed out has its response
 * discarded by the transport, so it must not advance the per-session diff
 * baseline or the "last inline-sent" metadata snapshot. Driven through the real
 * DefaultAfterToolCallHandler with the request's AbortSignal.
 */
describe("DefaultAfterToolCallHandler cancelled-call baseline (#10081)", () => {
  const SESSION = "session-1";
  const metadata = {
    deviceId: "emulator-5554",
    backStack: { depth: 1 },
    deviceLock: { isLocked: false },
  };

  let baselines: Map<string, ObserveResult>;
  let snapshots: Map<string, Record<string, unknown>>;
  let originalManager: unknown;
  let originalDiff: boolean;
  let originalCompact: boolean;
  let initialized: ReturnType<typeof spyOn>;

  function screen(): ObserveResult {
    return {
      updatedAt: 1,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
      viewHierarchy: {
        packageName: "com.example",
        hierarchy: {
          node: {
            "resource-id": "com.example:id/root",
            node: [{ "resource-id": "com.example:id/child", text: "Hello" }],
          },
        },
      },
      ...structuredClone(metadata),
    } as ObserveResult;
  }

  async function call(signal?: AbortSignal) {
    const handler = new DefaultAfterToolCallHandler();
    const result = await handler.handle({
      name: "tapOn",
      args: {},
      device: undefined,
      internalCall: false,
      response: createStructuredToolResponse({ success: true, observation: screen() }),
      sessionUuid: SESSION,
      shouldResolveDevice: false,
      signal,
      timer: new FakeTimer(),
      toolStartMs: 0,
    });
    return getStructuredPayload(result.finalizedResponse) as Record<string, any>;
  }

  beforeEach(() => {
    baselines = new Map();
    snapshots = new Map();
    const daemon = DaemonState.getInstance();
    originalManager = Reflect.get(daemon, "sessionManager");
    Reflect.set(daemon, "sessionManager", {
      getLastRenderedObservation: (uuid: string) => baselines.get(uuid),
      setLastRenderedObservation: (uuid: string, observation: ObserveResult) => {
        baselines.set(uuid, observation);
      },
      getLastActionMetadata: (uuid: string) => snapshots.get(uuid),
      setLastActionMetadata: (uuid: string, _deviceId: string, blocks: Record<string, unknown>) => {
        snapshots.set(uuid, blocks);
      },
      setLastRenderedDisplayRevision: () => {},
    });
    initialized = spyOn(daemon, "isInitialized").mockReturnValue(true);
    originalDiff = serverConfig.isActionsDiffObserveEnabled();
    originalCompact = serverConfig.isActionsCompactMetadataEnabled();
    serverConfig.setActionsDiffObserveEnabled(true);
    serverConfig.setActionsCompactMetadataEnabled(true);
  });

  afterEach(() => {
    initialized.mockRestore();
    Reflect.set(DaemonState.getInstance(), "sessionManager", originalManager);
    serverConfig.setActionsDiffObserveEnabled(originalDiff);
    serverConfig.setActionsCompactMetadataEnabled(originalCompact);
  });

  test("finalization uses the connection preference instead of the daemon default", async () => {
    serverConfig.setActionsDiffObserveEnabled(false);
    await call();
    const full = await runWithToolSelectionContext({ actionsCompactMetadata: false }, () => call());
    expect(full.observation.backStack).toEqual(metadata.backStack);
    expect(full.observation.deviceLock).toEqual(metadata.deviceLock);
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(true);
    const compact = await runWithToolSelectionContext({ actionsCompactMetadata: true }, () =>
      call(),
    );
    expect(compact.observation.backStack).toBeUndefined();
    expect(compact.observation.deviceLock).toBeUndefined();
  });

  test("a cancelled call leaves the baseline and snapshot empty so the next call gets the full blocks", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await call(cancelled.signal);

    expect(baselines.size).toBe(0);
    expect(snapshots.size).toBe(0);

    const next = await call(new AbortController().signal);
    expect(next.observationDiff).toMatchObject({ mode: "full", reason: "missing_baseline" });
    expect(next.observation.backStack).toEqual(metadata.backStack);
    expect(next.observation.deviceLock).toEqual(metadata.deviceLock);
    expect(baselines.size).toBe(1);
    expect(snapshots.size).toBe(1);
  });

  test("a call that is not aborted still advances the baseline and compacts the next response", async () => {
    await call(new AbortController().signal);
    const next = await call(new AbortController().signal);

    expect(next.observationDiff).toMatchObject({ mode: "diff" });
    expect(next.observation.backStack).toBeUndefined();
    expect(next.observation.deviceLock).toBeUndefined();
  });

  test("a call aborted after a delivered one keeps the delivered baseline", async () => {
    await call(new AbortController().signal);
    const delivered = baselines.get(SESSION);
    const deliveredSnapshot = snapshots.get(SESSION);
    const cancelled = new AbortController();
    cancelled.abort();
    await call(cancelled.signal);

    expect(baselines.get(SESSION)).toBe(delivered);
    expect(snapshots.get(SESSION)).toBe(deliveredSnapshot);
  });

  describe("client cancellation vs daemon-side abort of the combined request signal", () => {
    test("a client cancel does not advance the baseline or snapshot", async () => {
      const daemon = new AbortController();
      const client = new AbortController();
      const requestSignal = combineRequestAbortSignals(daemon.signal, client.signal);
      client.abort();
      await call(requestSignal);

      expect(baselines.size).toBe(0);
      expect(snapshots.size).toBe(0);
    });

    test("a daemon-side abort of a returned success advances the baseline and snapshot", async () => {
      const daemon = new AbortController();
      const client = new AbortController();
      const requestSignal = combineRequestAbortSignals(daemon.signal, client.signal);
      daemon.abort();
      await call(requestSignal);

      expect(baselines.size).toBe(1);
      expect(snapshots.size).toBe(1);

      const next = await call(new AbortController().signal);
      expect(next.observationDiff).toMatchObject({ mode: "diff" });
    });

    test("a daemon-side abort with no client signal still delivers a success", async () => {
      const daemon = new AbortController();
      const requestSignal = combineRequestAbortSignals(daemon.signal, undefined);
      daemon.abort();
      await call(requestSignal);

      expect(baselines.size).toBe(1);
    });

    test("a failure under a daemon-side abort stays undelivered", async () => {
      const daemon = new AbortController();
      const requestSignal = combineRequestAbortSignals(daemon.signal, new AbortController().signal);
      daemon.abort();
      const handler = new DefaultAfterToolCallHandler();
      await handler.handle({
        name: "tapOn",
        args: {},
        device: undefined,
        internalCall: false,
        response: createStructuredToolResponse({ success: false, observation: screen() }),
        sessionUuid: SESSION,
        shouldResolveDevice: false,
        signal: requestSignal,
        timer: new FakeTimer(),
        toolStartMs: 0,
      });

      expect(baselines.size).toBe(0);
    });
  });
});
