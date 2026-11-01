import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { defaultDaemonContext } from "../../../src/daemon/daemonContext";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { unidentifiedToolTargetRow } from "../../../src/server/pipeline/deviceCallDispatch";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { makePool } from "../../helpers/makePool";

// A caller's platform label never skips the held-device identity check: an id that may be an Android
// transport still gets its row, whatever platform the call names. Only a device the pool already
// knows is not Android is skipped (#14908).

const EMULATOR: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const WATCH: BootedDevice = {
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  name: "Apple Watch Series 10 (46mm)",
  platform: "watchos",
};

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
});

function withUnassignableTransports(): void {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const pool = makePool(sessions, "identity-row-daemon", {
    timer,
    deviceManager: new FakeDeviceUtils(),
  });
  const assignable = spyOn(pool, "isAndroidTransportAssignable").mockReturnValue(false);
  const reads = spyOn(defaultDaemonContext, "devicePool").mockReturnValue(pool);
  restores.push(
    () => assignable.mockRestore(),
    () => reads.mockRestore(),
  );
}

describe("unidentifiedToolTargetRow with a watchOS label", () => {
  test("an Android transport id labelled watchos still gets its identity row", async () => {
    withUnassignableTransports();

    const row = await unidentifiedToolTargetRow({
      deviceId: EMULATOR.deviceId,
      platform: "watchos",
      device: EMULATOR,
      readOnly: false,
    });

    expect(row).toEqual(EMULATOR);
  });

  test("a device the pool knows is a watch needs no Android row", async () => {
    withUnassignableTransports();

    const row = await unidentifiedToolTargetRow({
      deviceId: WATCH.deviceId,
      platform: "watchos",
      device: WATCH,
      readOnly: false,
    });

    expect(row).toBeUndefined();
  });
});
