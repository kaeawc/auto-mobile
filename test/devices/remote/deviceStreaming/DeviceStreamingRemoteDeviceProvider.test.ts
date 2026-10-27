import { describe, expect, test } from "bun:test";
import { DeviceStreamingApiError } from "../../../../src/devices/remote/deviceStreaming/DeviceStreamingApiError";
import { DeviceStreamingRemoteDeviceProvider } from "../../../../src/devices/remote/deviceStreaming/DeviceStreamingRemoteDeviceProvider";
import type { RemoteDeviceProvider } from "../../../../src/devices/remote/remoteDeviceProvider";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { FakeDeviceStreamingApi } from "../../../fakes/FakeDeviceStreamingApi";
import { FakeRemoteDeviceProvider } from "../../../fakes/FakeRemoteDeviceProvider";
import { FakeTimer } from "../../../fakes/FakeTimer";

const NAME = "projects/p1/deviceSessions/automobile-id-1";
const MINUTE_MS = 60_000;
const request = { modelId: "tokay", osVersionId: "34", minutes: 10 };

function setup(guards = { optIn: true, maxSessionMinutes: 30 }) {
  const api = new FakeDeviceStreamingApi();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const provider = new DeviceStreamingRemoteDeviceProvider({
    api,
    projectId: "p1",
    guards,
    timer,
    ids: new CountingIdGenerator(),
    pollIntervalMs: 1_000,
    allocationTimeoutMs: 5_000,
  });
  return { api, timer, provider };
}

/** Starts a reservation and scripts the polls that follow its create call. */
async function reserveWith(
  harness: ReturnType<typeof setup>,
  ...states: Parameters<FakeDeviceStreamingApi["queueGets"]>[1][]
) {
  const reservation = harness.provider.reserve(request);
  await Promise.resolve();
  harness.api.queueGets(NAME, ...states);
  return reservation;
}

describe("DeviceStreamingRemoteDeviceProvider.reserve", () => {
  test("creates a session sized to the request and polls until it is active", async () => {
    const harness = setup();

    const reservation = await reserveWith(
      harness,
      { state: "pending" },
      { state: "active", activeStartTimeMs: 0, expireTimeMs: 10 * MINUTE_MS },
    );

    expect(harness.api.creates).toEqual([
      {
        projectId: "p1",
        sessionId: "automobile-id-1",
        modelId: "tokay",
        osVersionId: "34",
        ttlMinutes: 10,
        locale: undefined,
        orientation: undefined,
      },
    ]);
    expect(harness.api.getCount).toBe(2);
    expect(reservation.session.state).toBe("active");
    expect(reservation.cost).toMatchObject({ minutes: 10, maxUsd: 1.5 });
  });

  test("refuses before creating anything when the caller has not opted in", async () => {
    const harness = setup({ optIn: false, maxSessionMinutes: 30 });

    await expect(harness.provider.reserve(request)).rejects.toThrow(/off by default/);
    expect(harness.api.creates).toHaveLength(0);
  });

  test("reports a session the lab could not allocate, with its state message", async () => {
    const harness = setup();

    await expect(
      reserveWith(harness, { state: "unavailable", stateMessage: "model not in catalog" }),
    ).rejects.toThrow(`session ${NAME} ended unavailable (model not in catalog)`);
    expect(harness.api.cancels).toHaveLength(0);
  });

  test("cancels a session still queued at the allocation deadline", async () => {
    const harness = setup();

    await expect(reserveWith(harness, { state: "pending" })).rejects.toThrow(
      /No remote device was allocated within 5s; .* cancelled while pending/,
    );
    expect(harness.api.cancels).toEqual([NAME]);
  });

  test("creates nothing when the caller already aborted", async () => {
    const harness = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(harness.provider.reserve(request, controller.signal)).rejects.toThrow(
      /cancelled before it was created/,
    );
    expect(harness.api.creates).toHaveLength(0);
  });

  test("cancels the session when the caller aborts while it is queued", async () => {
    const harness = setup();
    const controller = new AbortController();
    const reservation = harness.provider.reserve(request, controller.signal);
    harness.api.queueGets(NAME, { state: "pending" });
    controller.abort();

    await expect(reservation).rejects.toThrow(/reservation was cancelled while requested/);
    expect(harness.api.cancels).toEqual([NAME]);
  });

  test("keeps the timeout error when the cleanup cancel also fails", async () => {
    const harness = setup();
    harness.api.cancelError = new Error("network down");

    await expect(reserveWith(harness, { state: "pending" })).rejects.toThrow(/No remote device/);
  });
});

describe("DeviceStreamingRemoteDeviceProvider.extend", () => {
  const active = { id: NAME, state: "active" as const, activeStartTimeMs: 0 };

  test("moves the expire time out by the added minutes", async () => {
    const { api, provider } = setup();
    api.seed({ ...active, expireTimeMs: 10 * MINUTE_MS });

    const reservation = await provider.extend(NAME, 15);

    expect(api.expireTimeUpdates).toEqual([{ name: NAME, expireTimeMs: 25 * MINUTE_MS }]);
    expect(reservation.cost).toMatchObject({ minutes: 15, maxUsd: 2.25 });
  });

  test("refuses an extension that takes the whole session past the cap", async () => {
    const { api, provider } = setup();
    api.seed({ ...active, expireTimeMs: 20 * MINUTE_MS });

    await expect(provider.extend(NAME, 15)).rejects.toThrow(/35-minute remote session/);
    expect(api.expireTimeUpdates).toHaveLength(0);
  });

  test("refuses to extend a session that is not active", async () => {
    const { api, provider } = setup();
    api.seed({ id: NAME, state: "expired", stateMessage: "reservation ended" });

    await expect(provider.extend(NAME, 5)).rejects.toThrow(
      /cannot be extended while expired \(reservation ended\)/,
    );
  });
});

describe("DeviceStreamingRemoteDeviceProvider.release", () => {
  test("treats a refused cancel of an ended session as released", async () => {
    const { api, provider } = setup();
    api.seed({ id: NAME, state: "expired" });
    api.cancelError = new DeviceStreamingApiError("already ended", 400, "FAILED_PRECONDITION");

    await provider.release(NAME);

    expect(api.cancels).toEqual([NAME]);
  });

  test("rethrows a refused cancel when the session is still running", async () => {
    const { api, provider } = setup();
    api.seed({ id: NAME, state: "active" });
    api.cancelError = new DeviceStreamingApiError("denied", 403, "PERMISSION_DENIED");

    await expect(provider.release(NAME)).rejects.toThrow("denied");
  });

  test("rethrows a server error without probing the session", async () => {
    const { api, provider } = setup();
    api.seed({ id: NAME, state: "active" });
    api.cancelError = new DeviceStreamingApiError("unavailable", 503, "UNAVAILABLE");

    await expect(provider.release(NAME)).rejects.toThrow("unavailable");
    expect(api.getCount).toBe(0);
  });
});

/** Both providers must honor the same observable contract. */
describe.each([
  ["FakeRemoteDeviceProvider", (): RemoteDeviceProvider => new FakeRemoteDeviceProvider()],
  [
    "DeviceStreamingRemoteDeviceProvider",
    (): RemoteDeviceProvider => {
      const harness = setup();
      const create = harness.api.create.bind(harness.api);
      harness.api.create = async (createRequest) => {
        const session = await create(createRequest);
        harness.api.seed({
          ...session,
          state: "active",
          activeStartTimeMs: 0,
          expireTimeMs: createRequest.ttlMinutes * MINUTE_MS,
        });
        return session;
      };
      return harness.provider;
    },
  ],
])("%s contract", (_name, makeProvider) => {
  test("reserve, extend and release one session", async () => {
    const provider = makeProvider();

    const { session } = await provider.reserve(request);
    const extended = await provider.extend(session.id, 5);
    await provider.release(session.id);

    expect(session.state).toBe("active");
    expect(extended.session.expireTimeMs).toBe(15 * MINUTE_MS);
    expect((await provider.get(session.id)).state).toBe("finished");
  });
});
