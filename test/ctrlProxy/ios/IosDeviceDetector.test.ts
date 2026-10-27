import { describe, expect, spyOn, test } from "bun:test";
import {
  IosDeviceDetector,
  SIMULATOR_STATE_ABSENT,
  type RemoteDeviceListingRunner,
} from "../../../src/ctrlProxy/ios/IosDeviceDetector";
import { createExecResult } from "../../../src/utils/execResult";
import { logger } from "../../../src/utils/logger";
import type {
  IosPhysicalDeviceLister,
  PhysicalIosDeviceDiscovery,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "00008120-001C2D3E1234567A";
const SIMULATOR_UDID = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalDevice = { deviceId: UDID, platform: "ios" as const, name: "iPhone" };

function listerReturning(discovery: PhysicalIosDeviceDiscovery): IosPhysicalDeviceLister {
  return { listConnectedDevices: async () => discovery };
}

function localDetector(
  deviceId: string,
  executor: FakeProcessExecutor,
  options: { lister?: IosPhysicalDeviceLister; timer?: FakeTimer } = {},
): IosDeviceDetector {
  return new IosDeviceDetector({
    deviceId,
    processExecutor: executor,
    timer: options.timer ?? new FakeTimer(),
    remoteRunner: unusedRemote(),
    useRemoteRunner: () => false,
    isSimulator: () => deviceId === SIMULATOR_UDID,
    physicalDeviceLister: options.lister ?? listerReturning({ devices: [], complete: true }),
  });
}

function unusedRemote(): RemoteDeviceListingRunner {
  return {
    runIdeviceId: async () => ({ success: false }),
    runSimctl: async () => ({ success: false }),
  };
}

describe("IosDeviceDetector (#11154)", () => {
  describe("physical device detection", () => {
    test("a USB listing is sufficient", async () => {
      const executor = new FakeProcessExecutor();
      executor.setCommandResponse("idevice_id -l", createExecResult(`${UDID}\n`, ""));
      expect(await localDetector(UDID, executor).isDeviceDetected()).toBe(true);
    });

    test("an idevice_id miss is not disconnect evidence while devicectl still lists the device", async () => {
      const lister = listerReturning({ devices: [physicalDevice], complete: true });
      expect(
        await localDetector(UDID, new FakeProcessExecutor(), { lister }).isDeviceDetected(),
      ).toBe(true);
    });

    test("an incomplete devicectl listing is not authoritative", async () => {
      const lister = listerReturning({
        devices: [],
        complete: false,
        error: { code: "failed", message: "devicectl blip" },
      });
      expect(
        await localDetector(UDID, new FakeProcessExecutor(), { lister }).isDeviceDetected(),
      ).toBe(true);
    });

    test("absent from both idevice_id and a complete devicectl listing means gone", async () => {
      expect(await localDetector(UDID, new FakeProcessExecutor()).isDeviceDetected()).toBe(false);
    });

    test("warns once when idevice_id cannot run, then falls back to devicectl", async () => {
      const executor = new FakeProcessExecutor();
      executor.setCommandHandler("idevice_id", () => {
        throw new Error("spawn idevice_id ENOENT");
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const detector = localDetector(UDID, executor, {
          lister: listerReturning({ devices: [physicalDevice], complete: true }),
        });
        expect(await detector.isDeviceDetected()).toBe(true);
        expect(await detector.isDeviceDetected()).toBe(true);
        const probeWarnings = warn.mock.calls.filter(([line]) =>
          String(line).includes("idevice_id probe failed"),
        );
        expect(probeWarnings).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("Wi-Fi-only devices", () => {
    test("tunnel start is rejected with an actionable error when only `idevice_id -l -n` lists it", async () => {
      const executor = new FakeProcessExecutor();
      executor.setCommandHandler("idevice_id", (command) =>
        createExecResult(command.endsWith("-n") ? `${UDID}\n` : "", ""),
      );
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      await expect(
        localDetector(UDID, executor, { timer }).assertUsbAttachedForTunnel(),
      ).rejects.toThrow(/Wi-Fi only.*USB/);
    });

    test("a transient `idevice_id -l` miss is retried once before rejecting as Wi-Fi only (#11186)", async () => {
      const executor = new FakeProcessExecutor();
      let usbProbes = 0;
      executor.setCommandHandler("idevice_id", (command) => {
        if (command.endsWith("-n")) {
          return createExecResult(`${UDID}\n`, "");
        }
        usbProbes += 1;
        return createExecResult(usbProbes === 1 ? "" : `${UDID}\n`, "");
      });
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      await localDetector(UDID, executor, { timer }).assertUsbAttachedForTunnel();
      expect(usbProbes).toBe(2);
      expect(timer.getSleepHistory()).toEqual([500]);
    });
  });

  describe("local simulator detection", () => {
    for (const configured of [false, true]) {
      test(
        configured
          ? "injects --set immediately after simctl"
          : "preserves the original argv when unset",
        async () => {
          const previous = process.env.CORESIMULATOR_DEVICE_SET_PATH;
          try {
            if (configured) {
              process.env.CORESIMULATOR_DEVICE_SET_PATH = "/tmp/custom device set";
            } else {
              delete process.env.CORESIMULATOR_DEVICE_SET_PATH;
            }
            const prefix = configured ? ["simctl", "--set", "/tmp/custom device set"] : ["simctl"];
            const exec = new FakeProcessExecutor();
            const capture = spyOn(exec, "executeCommand");
            exec.setDefaultResponse(createExecResult(SIMULATOR_UDID, ""));
            const timer = new FakeTimer();
            expect(await localDetector(SIMULATOR_UDID, exec, { timer }).isDeviceDetected()).toBe(
              true,
            );
            expect(capture.mock.calls).toEqual([["xcrun", [...prefix, "list", "devices"]]]);
            expect(timer.getSleepHistory()).toEqual([]);
          } finally {
            if (previous === undefined) {
              delete process.env.CORESIMULATOR_DEVICE_SET_PATH;
            } else {
              process.env.CORESIMULATOR_DEVICE_SET_PATH = previous;
            }
          }
        },
      );
    }
  });

  describe("remote simulator detection", () => {
    test.each(["present", "absent", "failed", "missing data", "throws"])("%s", async (branch) => {
      const failure = new Error("enumeration unavailable");
      const list = async (): ReturnType<RemoteDeviceListingRunner["runSimctl"]> => {
        if (branch === "throws") {
          throw failure;
        }
        if (branch === "failed") {
          return { success: false };
        }
        if (branch === "missing data") {
          return { success: true };
        }
        return { success: true, data: { stdout: branch === "present" ? SIMULATOR_UDID : "" } };
      };
      const requests: string[][] = [];
      const detector = new IosDeviceDetector({
        deviceId: SIMULATOR_UDID,
        processExecutor: new FakeProcessExecutor(),
        timer: new FakeTimer(),
        remoteRunner: {
          ...unusedRemote(),
          runSimctl: (args) => {
            requests.push(args);
            return list();
          },
        },
        useRemoteRunner: () => true,
        isSimulator: () => true,
      });
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      try {
        expect(await detector.isDeviceDetected()).toBe(branch === "present");
        expect(requests).toEqual([["list", "devices"]]);
        expect(debug.mock.calls).toEqual(
          branch === "throws"
            ? [
                [
                  "src/ctrlProxy/ios/IosDeviceDetector.ts fallback failed: Error: enumeration unavailable",
                  failure,
                ],
              ]
            : [],
        );
      } finally {
        debug.mockRestore();
      }
    });
  });

  describe("remote physical detection", () => {
    test("lists the device through the host-control runner", async () => {
      const detector = new IosDeviceDetector({
        deviceId: UDID,
        processExecutor: new FakeProcessExecutor(),
        timer: new FakeTimer(),
        remoteRunner: {
          ...unusedRemote(),
          runIdeviceId: async () => ({ success: true, data: { stdout: `other\n${UDID}\n` } }),
        },
        useRemoteRunner: () => true,
        isSimulator: () => false,
      });
      expect(await detector.isDeviceDetected()).toBe(true);
    });
  });
});

describe("positive-only simulator shutdown detection", () => {
  const cases = [
    ["Shutdown", true],
    ["Shutting Down", true],
    ["Booted", false],
    ["Booting", false],
    // A complete listing without this udid: the simulator was deleted (#15309).
    ["absent", true],
    ["empty", false],
    ["malformed", false],
    ["malformed runtime", false],
    ["missing state", false],
    ["empty state", false],
    ["numeric state", false],
    ["error", false],
    ["remote failure", false],
  ] as const;
  for (const remote of [false, true]) {
    test.each(cases)(`shutdown state %s (remote=${remote})`, async (state, expected) => {
      const executor = new FakeProcessExecutor();
      const stdout =
        state === "empty"
          ? ""
          : state === "malformed"
            ? "{"
            : JSON.stringify({
                devices: {
                  runtime:
                    state === "malformed runtime"
                      ? { udid: SIMULATOR_UDID, state: "Shutdown" }
                      : [
                          {
                            udid: state === "absent" ? "other" : SIMULATOR_UDID,
                            state:
                              state === "missing state"
                                ? undefined
                                : state === "empty state"
                                  ? ""
                                  : state === "numeric state"
                                    ? 1
                                    : state,
                          },
                        ],
                },
              });
      const read = () => {
        if (state === "error") {
          throw new Error("simctl failed");
        }
        return stdout;
      };
      executor.setCommandHandler("xcrun", () => createExecResult(read(), ""));
      const calls: string[][] = [];
      const detector = new IosDeviceDetector({
        deviceId: SIMULATOR_UDID,
        processExecutor: executor,
        timer: new FakeTimer(),
        isSimulator: () => true,
        useRemoteRunner: () => remote,
        remoteRunner: {
          ...unusedRemote(),
          runSimctl: async (args) => {
            calls.push(args);
            return state === "remote failure"
              ? { success: false }
              : { success: true, data: { stdout: read() } };
          },
        },
      });
      const unknown =
        [
          "empty",
          "malformed",
          "malformed runtime",
          "missing state",
          "empty state",
          "numeric state",
          "error",
        ].includes(state) ||
        (remote && state === "remote failure");
      expect(await detector.getSimulatorState()).toBe(
        unknown ? undefined : state === "absent" ? SIMULATOR_STATE_ABSENT : state,
      );
      expect(await detector.isSimulatorShutDown()).toBe(expected);
      if (remote) {
        expect(calls).toEqual(Array(2).fill(["list", "devices", "--json"]));
      } else {
        expect(executor.wasCommandExecuted("list devices --json")).toBe(true);
      }
    });
  }
});
