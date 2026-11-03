import { describe, expect, test } from "bun:test";
import {
  AndroidRemoteDeviceConnectSetup,
  type RemoteCtrlProxyInstaller,
} from "../../../src/devices/remote/androidRemoteDeviceConnectSetup";
import type { BootedDevice } from "../../../src/models";
import type { ProxySetupResult } from "../../../src/utils/interfaces/ProxyManager";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDeviceTraits, physicalDeviceTraits } from "../../fakes/FakeDeviceTraits";

const SERIAL = "127.0.0.1:5001";

class FakeInstaller implements RemoteCtrlProxyInstaller {
  readonly events: string[] = [];
  result: ProxySetupResult = { success: true, message: "installed" };

  forgetDevice(serial: string): void {
    this.events.push(`forget ${serial}`);
  }

  async install(device: BootedDevice): Promise<ProxySetupResult> {
    this.events.push(`install ${device.deviceId} ${device.platform}`);
    return this.result;
  }
}

function setup() {
  const ctrlProxy = new FakeInstaller();
  const readers: FakeDeviceTraits[] = [];
  const connectSetup = new AndroidRemoteDeviceConnectSetup({
    ctrlProxy,
    adbFactory: new FakeAdbClientFactory(),
    createTraitsReader: () => {
      const reader = new FakeDeviceTraits(
        physicalDeviceTraits({ manufacturer: "Xiaomi", brand: "Redmi", model: "23090RA98G" }),
      );
      readers.push(reader);
      return reader;
    },
  });
  return { ctrlProxy, readers, connectSetup };
}

describe("AndroidRemoteDeviceConnectSetup", () => {
  test("forgets the serial's earlier device before force-installing CtrlProxy", async () => {
    const { ctrlProxy, connectSetup } = setup();

    await connectSetup.installCtrlProxy(SERIAL);

    expect(ctrlProxy.events).toEqual([`forget ${SERIAL}`, `install ${SERIAL} android`]);
  });

  test("a failed install names the device and the reason", async () => {
    const { ctrlProxy, connectSetup } = setup();
    ctrlProxy.result = {
      success: false,
      message: "setup failed",
      error: "INSTALL_FAILED_USER_RESTRICTED",
    };

    await expect(connectSetup.installCtrlProxy(SERIAL)).rejects.toThrow(
      `CtrlProxy could not be installed on remote device ${SERIAL}: INSTALL_FAILED_USER_RESTRICTED`,
    );
  });

  test("reads manufacturer, brand and model with a fresh reader per connect", async () => {
    const { readers, connectSetup } = setup();

    expect(await connectSetup.readIdentity(SERIAL)).toEqual({
      manufacturer: "Xiaomi",
      brand: "Redmi",
      model: "23090RA98G",
    });
    await connectSetup.readIdentity(SERIAL);

    expect(readers).toHaveLength(2);
    expect(readers[0]?.reads).toEqual([{ deviceId: SERIAL, options: { timeoutMs: 10_000 } }]);
  });
});
