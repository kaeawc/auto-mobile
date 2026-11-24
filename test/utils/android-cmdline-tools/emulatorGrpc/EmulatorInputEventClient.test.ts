import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import {
  EmulatorInputEventClient,
  STREAM_INPUT_EVENT_METHOD,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorInputEventClient";
import type { GrpcAuthorizer } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import { GrpcStatus } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/grpcFraming";
import { FakeGrpcTransport } from "../../../fakes/FakeGrpcTransport";
import { FakeTimer } from "../../../fakes/FakeTimer";

function authorizer(value: string | undefined): GrpcAuthorizer & { methods: string[] } {
  const methods: string[] = [];
  return {
    methods,
    authorization: async (method) => {
      methods.push(method);
      return value;
    },
    dispose: async () => {},
  };
}

/** `null` models an endpoint without auth (`authorization()` resolves undefined). */
function setup(token: string | null = "Bearer t") {
  const transport = new FakeGrpcTransport();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const auth = authorizer(token ?? undefined);
  return { transport, timer, auth, client: new EmulatorInputEventClient(transport, auth, timer) };
}

const events = [
  { message: Uint8Array.of(1), delayAfterMs: 50 },
  { message: Uint8Array.of(2), delayAfterMs: 100 },
  { message: Uint8Array.of(3), delayAfterMs: 0 },
];

describe("EmulatorInputEventClient", () => {
  test("streams every event in order on streamInputEvent, pausing between them, then half-closes", async () => {
    const { client, transport, timer, auth } = setup();
    await client.send(events);
    expect(STREAM_INPUT_EVENT_METHOD).toBe(
      "/android.emulation.control.EmulatorController/streamInputEvent",
    );
    expect(auth.methods).toEqual([STREAM_INPUT_EVENT_METHOD]);
    expect(transport.calls).toHaveLength(1);
    const [call] = transport.calls;
    expect(call.method).toBe(STREAM_INPUT_EVENT_METHOD);
    expect(call.metadata).toEqual({ authorization: "Bearer t" });
    expect(call.written.map((message) => [...message])).toEqual([[1], [2], [3]]);
    expect(call.ended).toBe(true);
    expect(timer.getSleepHistory()).toEqual([50, 100]);
  });

  test("sends no authorization header when the endpoint needs none", async () => {
    const { client, transport } = setup(null);
    await client.send(events);
    expect(transport.calls[0].metadata).toEqual({});
  });

  test("a non-OK final status is an actionable error naming the status", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = { code: GrpcStatus.UNIMPLEMENTED, message: "unknown method" };
    };
    const failure = client.send(events);
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow(/gRPC status 12: unknown method.*35\.4 or newer/);
  });

  test("an access-list refusal points at the emulator's gRPC access control", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = { code: GrpcStatus.PERMISSION_DENIED, message: "not on the allowlist" };
    };
    await expect(client.send(events)).rejects.toThrow(/access list or token refused/);
  });

  test("a server that closes the stream mid-gesture reports its status, not the write error", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.onWrite = (index) => {
        if (index === 1) {
          call.finish({ code: GrpcStatus.UNAUTHENTICATED, message: "no token" });
          return Promise.reject(new Error("gRPC stream closed before the write completed"));
        }
      };
    };
    await expect(client.send(events)).rejects.toThrow(/gRPC status 16: no token/);
    expect(transport.calls[0].written).toHaveLength(2);
  });

  test("an aborted gesture cancels the call and rethrows the abort", async () => {
    const { client, transport } = setup();
    const controller = new AbortController();
    transport.onOpen = (call) => {
      call.onWrite = () => controller.abort(new Error("caller gave up"));
    };
    await expect(client.send(events, controller.signal)).rejects.toThrow("caller gave up");
    expect(transport.calls[0].cancelled).toBe(true);
    expect(transport.calls[0].written).toHaveLength(1);
  });
});
