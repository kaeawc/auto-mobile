import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TerminateApp } from "../../../src/features/action/TerminateApp";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { AdbDeviceTransportUnavailableError } from "../../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { launchFailure } from "../../../src/server/launchAppFailure";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured shapes from #17096 (serial and package anonymized there; kept verbatim here).
const SERIAL = "emulator-5556";
const PACKAGE = "com.example.app";
const PROCESSES = "shell dumpsys activity processes";
const INSTALLED = "shell pm list packages --user 0";

function dumpsysStreamClosed(): Error {
  return Object.assign(new Error(`Command failed: adb -s ${SERIAL} ${PROCESSES}`), {
    code: 255,
    stdout: "",
    stderr: "",
  });
}

/** The adb layer's post-dispatch typing of a cut `dumpsys` stream (#17096 shape 2). */
function postDispatchLoss(): AdbDeviceTransportUnavailableError {
  return new AdbDeviceTransportUnavailableError(SERIAL, dumpsysStreamClosed(), 1000, "unknown");
}

describe("app-state probe transport loss (#17096)", () => {
  const device: BootedDevice = { deviceId: SERIAL, name: "Pixel", platform: "android" };
  let adb: FakeAdbExecutor;
  let timer: FakeTimer;
  let ctrlProxySpy:
    | ReturnType<typeof spyOn<typeof AndroidCtrlProxyClient, "getInstance">>
    | undefined;

  /** Installed after construction: observation wiring resolves the client eagerly. */
  const blockCtrlProxy = () => {
    ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("CtrlProxy unavailable");
    });
  };

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setCommandResponse(INSTALLED, createExecResult(`package:${PACKAGE}\n`, ""));
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  afterEach(() => ctrlProxySpy?.mockRestore());

  test("terminateApp's running probe surfaces a retryable, undispatched transport error", async () => {
    let reads = 0;
    const execute = adb.executeCommand.bind(adb);
    spyOn(adb, "executeCommand").mockImplementation(async (command, options) => {
      if (command === PROCESSES) {
        reads += 1;
        throw postDispatchLoss();
      }
      return execute(command, options);
    });

    const terminateApp = new TerminateApp(device, adb, { timer });
    blockCtrlProxy();
    const outcome = terminateApp.execute(PACKAGE, { skipObservation: true });

    await expect(outcome).rejects.toBeInstanceOf(AdbDeviceTransportUnavailableError);
    await expect(outcome).rejects.toMatchObject({
      code: "device_transport_unavailable",
      retryable: true,
      dispatched: false,
      deviceId: SERIAL,
    });
    // The read-only probe was replayed under the bounded transport policy.
    expect(reads).toBe(5);
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("terminateApp's installed probe keeps a typed refusal", async () => {
    const refusal = new AdbDeviceTransportUnavailableError(
      SERIAL,
      new Error("adb: device offline"),
    );
    adb.setCommandError(INSTALLED, refusal);
    adb.setCommandResponse(PROCESSES, createExecResult("", ""));

    const terminateApp = new TerminateApp(device, adb, { timer });
    blockCtrlProxy();
    const outcome = terminateApp.execute(PACKAGE, { skipObservation: true });

    await expect(outcome).rejects.toBe(refusal);
    await expect(outcome).rejects.toMatchObject({ retryable: true, dispatched: false });
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("launchApp's own running probe reports the launch as undispatched", async () => {
    const execute = adb.executeCommand.bind(adb);
    spyOn(adb, "executeCommand").mockImplementation(async (command, options) => {
      if (command === PROCESSES) {
        throw postDispatchLoss();
      }
      return execute(command, options);
    });
    const launchApp = new LaunchApp(device, { adb, simctl: null, timer });
    blockCtrlProxy();

    const outcome = launchApp.execute(PACKAGE, { clearAppData: false, coldBoot: false });

    await expect(outcome).rejects.toMatchObject({
      code: "device_transport_unavailable",
      retryable: true,
      dispatched: false,
    });
    expect(adb.getExecutedCommands().some((command) => command.includes("am start"))).toBe(false);
  });

  test("launchApp's cold-boot stop keeps the typed error through launchFailure", async () => {
    let reads = 0;
    const execute = adb.executeCommand.bind(adb);
    spyOn(adb, "executeCommand").mockImplementation(async (command, options) => {
      if (command === PROCESSES) {
        reads += 1;
        // LaunchApp's own read sees the app running; the cold-boot stop's read loses transport.
        if (reads === 1) {
          return createExecResult(`123:${PACKAGE}/u0a123\n`, "");
        }
        throw postDispatchLoss();
      }
      return execute(command, options);
    });
    const coldBoot = new TerminateApp(device, adb, { timer });
    const launchApp = new LaunchApp(device, {
      adb,
      simctl: null,
      timer,
      dependencies: {
        createAndroidColdBoot: () => coldBoot,
      },
    });
    blockCtrlProxy();

    const error = await launchApp.execute(PACKAGE, { clearAppData: false, coldBoot: true }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(launchFailure(error, device, PACKAGE, undefined)).toMatchObject({
      code: "device_transport_unavailable",
      retryable: true,
      dispatched: false,
    });
    expect(adb.getExecutedCommands().some((command) => command.includes("am start"))).toBe(false);
  });
});
