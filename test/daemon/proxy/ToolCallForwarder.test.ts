import { describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../../src/daemon/client/client";
import {
  ToolCallForwarder,
  type ForwardedResultContext,
  type ForwardedToolCall,
  type ToolCallForwarderPort,
} from "../../../src/daemon/proxy/ToolCallForwarder";
import { ReleaseEpochLedger } from "../../../src/daemon/proxy/ReleaseEpochLedger";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeTimer } from "../../fakes/FakeTimer";

type Listeners = ConstructorParameters<typeof ToolCallForwarder>[0]["progressListeners"];

interface Harness {
  forwarder: ToolCallForwarder;
  events: string[];
  sent: Array<{ name: string; args: Record<string, unknown> }>;
  listeners: Listeners;
  ledger: ReleaseEpochLedger;
  contexts: ForwardedResultContext[];
  setResult(result: unknown): void;
  setSendError(error: unknown): void;
  deferNext(): void;
}

function createHarness(): Harness {
  const events: string[] = [];
  const sent: Harness["sent"] = [];
  const contexts: ForwardedResultContext[] = [];
  const listeners: Listeners = new Map();
  const ledger = new ReleaseEpochLedger();
  let result: unknown = { content: [] };
  let sendError: unknown;
  let defer = false;
  class StubClient extends FakeDaemonClient {
    override async callTool(
      name: string,
      args: Record<string, unknown>,
      _progressToken?: string | number,
      onRequestId?: (requestId: string) => void,
    ): Promise<unknown> {
      sent.push({ name, args });
      onRequestId?.("req-1");
      if (sendError !== undefined) {
        throw sendError;
      }
      return result;
    }
  }
  const client: DaemonClientLike = new StubClient();
  const port: ToolCallForwarderPort = {
    hasLivenessLifecycleFence: () => false,
    waitForLivenessRecovery: async () => {
      events.push("wait");
    },
    hasStallHandovers: () => false,
    withFencedControlDeviceSession: (_name, args) => args,
    ownSessionForPlatformSelector: () => undefined,
    refuseAmbiguousSessionSelector: () => {},
    reportToolSessionLoss: () => {},
    prepareToolRoutingArgs: (_name, args) => ({
      forwardedArgs: { ...args, sessionUuid: "s1" },
      allowReleasedSession: false,
    }),
    sessionUuidFromArgs: (args) =>
      typeof args.sessionUuid === "string" ? args.sessionUuid : undefined,
    withOneShotCliMarker: (args) => args,
    withAcceptanceConfiguration: (args) => args,
    withToolSelectionProfile: (args) => args,
    beginSessionCall: (_name, uuids) => {
      events.push(`begin:${uuids.join(",")}`);
      return uuids;
    },
    sessionsUsedByCall: (uuid) => (uuid === undefined ? [] : [uuid]),
    endSessionCall: (uuids) => {
      events.push(`end:${uuids.join(",")}`);
    },
    throwIfForwardedSessionReleasedSince: () => {},
    requireClient: () => client,
    trackToolCallInFlight: (_client, send) => send(),
    withRecoverableReconnect: (operation) => operation(),
    deferredToTask: (_tasks, _result, context) => {
      contexts.push(context);
      return defer;
    },
    applyForwardedResult: (context, applied): ForwardedToolCall => {
      events.push(`apply:${[...listeners.values()].reduce((n, m) => n + m.size, 0)}`);
      return { result: applied, forwardedSessionUuid: context.forwardedSessionUuid };
    },
    noteReleaseSurfacedBy: () => {},
    removeProgressListener: (c, requestId) => {
      if (c && requestId !== undefined) {
        listeners.get(c)?.delete(requestId);
      }
    },
    toolUnavailableError: async (name) => new Error(`unavailable:${name}`),
  };
  const forwarder = new ToolCallForwarder({
    timer: new FakeTimer(),
    progressListeners: listeners,
    releaseLedger: ledger,
    heldSessionLosses: { reportPlatformLoss: () => {} },
    handoverResolution: { resumeStalledSessionNamedBy: async () => {} },
    sessionBinding: { refreshReplayLeaseAfterAdmittedFailure: () => {} },
    errorClassifier: {
      isUnknownToolError: (error) => error instanceof Error && error.message === "unknown tool",
      isGatedToolError: () => false,
    },
    port,
  });
  return {
    forwarder,
    events,
    sent,
    listeners,
    ledger,
    contexts,
    setResult: (value) => {
      result = value;
    },
    setSendError: (error) => {
      sendError = error;
    },
    deferNext: () => {
      defer = true;
    },
  };
}

const MODE = { allowSuspectRetry: true } as const;

describe("ToolCallForwarder", () => {
  test("forwards the routed args and applies the result between begin and end of the call", async () => {
    const h = createHarness();
    h.setResult({ content: [{ type: "text", text: "ok" }] });
    const out = await h.forwarder.forward("observe", { a: 1 }, undefined, { ...MODE });
    expect(h.sent).toEqual([{ name: "observe", args: { a: 1, sessionUuid: "s1" } }]);
    expect(out.forwardedSessionUuid).toBe("s1");
    expect(h.events).toEqual(["begin:s1", "apply:0", "end:s1"]);
    expect(h.contexts[0]).toMatchObject({
      name: "observe",
      callerArgs: { a: 1 },
      forwardedSessionUuid: "s1",
      isSessionAcquisition: false,
      learnsResultSession: false,
      allowSuspectRetry: true,
    });
  });

  test("a result deferred to a task is returned without being applied", async () => {
    const h = createHarness();
    h.deferNext();
    const out = await h.forwarder.forward("observe", {}, undefined, { ...MODE });
    expect(out.result).toEqual({ content: [] });
    expect(h.events.some((e) => e.startsWith("apply"))).toBe(false);
    expect(h.events.at(-1)).toBe("end:s1");
  });

  test("registers a progress listener for the request and removes it when the call settles", async () => {
    const h = createHarness();
    const seen: number[] = [];
    h.setResult({ content: [] });
    await h.forwarder.forward("observe", {}, "tok", { onProgress: (p) => seen.push(p), ...MODE });
    expect(h.events).toContain("apply:1");
    expect([...h.listeners.values()].every((m) => m.size === 0)).toBe(true);
  });

  test("an unknown-tool failure becomes the actionable unavailable error and still cleans up", async () => {
    const h = createHarness();
    h.setSendError(new Error("unknown tool"));
    await expect(h.forwarder.forward("observe", {}, undefined, { ...MODE })).rejects.toThrow(
      "unavailable:observe",
    );
    expect(h.events).toEqual(["begin:s1", "end:s1"]);
    expect(h.ledger.activeReleaseEpochReferences.size).toBe(0);
  });

  test("any other failure is rethrown unchanged", async () => {
    const h = createHarness();
    const boom = new Error("boom");
    h.setSendError(boom);
    await expect(h.forwarder.forward("observe", {}, undefined, { ...MODE })).rejects.toBe(boom);
    expect(h.events.at(-1)).toBe("end:s1");
  });

  test("an already-aborted signal rejects before anything is sent", async () => {
    const h = createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.forwarder.forward("observe", {}, undefined, { signal: controller.signal, ...MODE }),
    ).rejects.toBeDefined();
    expect(h.sent).toEqual([]);
  });
});
