import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbDeviceState } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../src/utils/logger";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const SERIAL = "emulator-5554";

function fixture(states: AdbDeviceState[]) {
  const adb = new FakeAdbExecutor();
  adb.setDeviceStates(states);
  const client = new AndroidEmulatorClient({
    timer: new FakeTimer(),
    adbFactory: new FakeAdbClientFactory(adb),
  });
  // Inventory enrichment is irrelevant to transport registration. Fake the online scan
  // while exercising the real non-device-state probe over fake adb.
  const online = spyOn(client, "getBootedDevicesChecked").mockResolvedValue(
    states
      .filter(({ state }) => state === "device")
      .map(({ deviceId }) => ({ deviceId, name: "Pixel", platform: "android" as const })),
  );
  const stateProbe = spyOn(adb, "getDeviceStates");
  return { client, online, stateProbe };
}

afterEach(() => mock.restore());

describe("AndroidEmulatorClient.isEmulatorSerialListed", () => {
  test.each(["offline", "unauthorized"])(
    "returns true for a serial listed as %s",
    async (state) => {
      const { client, online, stateProbe } = fixture([{ deviceId: SERIAL, state }]);
      const signal = new AbortController().signal;

      expect(await client["isEmulatorSerialListed"](SERIAL, signal)).toBe(true);
      expect(online).toHaveBeenCalledWith(
        true,
        { bypassDeviceListCache: true, skipNameEnrichment: true, skipProfileEnrichment: true },
        signal,
      );
      expect(stateProbe).toHaveBeenCalledWith({ signal, throwOnMissingAdb: true });
    },
  );

  test("returns true for a serial listed as device without a fallback probe", async () => {
    const { client, stateProbe } = fixture([{ deviceId: SERIAL, state: "device" }]);

    expect(await client["isEmulatorSerialListed"](SERIAL)).toBe(true);
    expect(stateProbe).not.toHaveBeenCalled();
  });

  test("returns false for an absent serial even when other serials are listed", async () => {
    const { client } = fixture([
      { deviceId: "emulator-5556", state: "offline" },
      { deviceId: "emulator-5558", state: "device" },
    ]);

    expect(await client["isEmulatorSerialListed"](SERIAL)).toBe(false);
  });

  test("returns false and debug logs an online probe error", async () => {
    const { client, online, stateProbe } = fixture([]);
    online.mockRejectedValue(new Error("adb unavailable"));
    const debug = spyOn(logger, "debug").mockImplementation(() => {});

    expect(await client["isEmulatorSerialListed"](SERIAL)).toBe(false);
    expect(stateProbe).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("adb unavailable"));
  });

  test("returns false and debug logs a non-device-state probe error", async () => {
    const { client, stateProbe } = fixture([]);
    stateProbe.mockRejectedValue(new Error("adb unavailable"));
    const debug = spyOn(logger, "debug").mockImplementation(() => {});

    expect(await client["isEmulatorSerialListed"](SERIAL)).toBe(false);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("adb unavailable"));
  });
});
