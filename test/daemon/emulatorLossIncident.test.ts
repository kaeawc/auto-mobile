import { describe, expect, test } from "bun:test";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncident,
} from "../../src/daemon/emulatorLossIncident";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

function createStore(): InMemoryEmulatorLossIncidentStore {
  return new InMemoryEmulatorLossIncidentStore(
    new FakeTimer(),
    new CountingIdGenerator("incident"),
  );
}

describe("emulator loss incident store", () => {
  test("retains a bounded, correlated recovery record", async () => {
    const store = createStore();

    const incident = await store.open({
      deviceId: "emulator-5554",
      avdName: "Pixel_9_Pro",
      detectionPath: "watched-process-exit",
      processExit: { code: 1, signal: null },
      outputTail: "token=[REDACTED]\nqemu exited",
      lastAdbState: "device",
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });
    await store.recordRecoveryAttempt(incident.id, { attempt: 1, outcome: "failed" });
    await store.recordRecoveryAttempt(incident.id, { attempt: 2, outcome: "succeeded" });
    await store.completeRecovery(incident.id, "recovered");

    expect(await store.get(incident.id)).toEqual<EmulatorLossIncident>({
      ...incident,
      recovery: {
        policy: { onLoss: true, maxAttempts: 2 },
        attempts: [
          { attempt: 1, outcome: "failed" },
          { attempt: 2, outcome: "succeeded" },
        ],
        outcome: "recovered",
      },
    });
  });

  test("keeps only the configured newest incident records", async () => {
    const store = new InMemoryEmulatorLossIncidentStore(
      new FakeTimer(),
      new CountingIdGenerator("incident"),
      2,
    );

    const first = await store.open({
      deviceId: "emulator-5554",
      detectionPath: "device-discovery-miss",
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
    });
    const second = await store.open({
      deviceId: "emulator-5556",
      detectionPath: "device-discovery-miss",
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
    });
    const third = await store.open({
      deviceId: "emulator-5558",
      detectionPath: "adb-transport-failure",
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
    });

    expect(await store.get(first.id)).toBeUndefined();
    expect((await store.list()).map((incident) => incident.id)).toEqual([third.id, second.id]);
  });

  test("list(0) returns no incidents, matching the repository", async () => {
    const store = createStore();
    await store.open({
      deviceId: "emulator-5554",
      detectionPath: "device-discovery-miss",
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
    });

    expect(await store.list(0)).toEqual([]);
  });
});
