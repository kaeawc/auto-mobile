import { describe, expect, test } from "bun:test";
import {
  extractAdbMissingDeviceId,
  isAdbMissingDeviceError,
  notifyAdbMissingDevice,
  onAdbMissingDevice,
  type AdbMissingDeviceEvent,
} from "../../../src/utils/android-cmdline-tools/AdbDeviceHealth";

describe("AdbDeviceHealth listener registry", () => {
  test("delivers the device id and message to a registered listener", () => {
    const received: AdbMissingDeviceEvent[] = [];
    const off = onAdbMissingDevice((event) => received.push(event));
    try {
      notifyAdbMissingDevice("emulator-5554", new Error("device 'emulator-5554' not found"));
    } finally {
      off();
    }

    expect(received).toEqual([
      { deviceId: "emulator-5554", message: "device 'emulator-5554' not found" },
    ]);
  });

  test("stops delivering to a listener after its unsubscribe function runs", () => {
    const received: AdbMissingDeviceEvent[] = [];
    const off1 = onAdbMissingDevice((event) => received.push(event));
    // off1() must run even if the assertions below throw, or the listener leaks
    // into every later test in the process (module-level Set is shared).
    try {
      off1();
      notifyAdbMissingDevice("emulator-5554", new Error("device not found"));
    } finally {
      off1();
    }

    expect(received).toEqual([]);
  });

  test("one throwing listener does not starve the listeners registered after it", () => {
    const received: string[] = [];
    const offThrowing = onAdbMissingDevice(() => {
      throw new Error("listener blew up");
    });
    const offRecording = onAdbMissingDevice((event) => received.push(event.deviceId));
    try {
      // Must not throw out of notify, and the second listener must still fire.
      notifyAdbMissingDevice("emulator-5556", new Error("device not found"));
    } finally {
      offThrowing();
      offRecording();
    }

    expect(received).toEqual(["emulator-5556"]);
  });

  test("delivers to every registered listener", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = onAdbMissingDevice((event) => a.push(event.deviceId));
    const offB = onAdbMissingDevice((event) => b.push(event.deviceId));
    try {
      notifyAdbMissingDevice("emulator-5558", new Error("no devices"));
    } finally {
      offA();
      offB();
    }

    expect(a).toEqual(["emulator-5558"]);
    expect(b).toEqual(["emulator-5558"]);
  });
});

describe("isAdbMissingDeviceError / extractAdbMissingDeviceId", () => {
  const extractRows: Array<{ name: string; input: unknown; expected: string | null }> = [
    {
      name: "quoted device-not-found",
      input: new Error("error: device 'emulator-5554' not found"),
      expected: "emulator-5554",
    },
    {
      name: "case-insensitive Device Not Found",
      input: new Error("Device 'pixel-7' Not Found"),
      expected: "pixel-7",
    },
    {
      name: "serial with colon/port",
      input: new Error("device '127.0.0.1:5555' not found"),
      expected: "127.0.0.1:5555",
    },
    {
      name: "generic no-quote message has no id",
      input: new Error("device not found"),
      expected: null,
    },
    { name: "unrelated error", input: new Error("permission denied"), expected: null },
    { name: "non-error string coerced", input: "device 'abc' not found", expected: "abc" },
  ];

  for (const row of extractRows) {
    test(`extractAdbMissingDeviceId returns ${JSON.stringify(row.expected)} for ${row.name}`, () => {
      expect(extractAdbMissingDeviceId(row.input)).toBe(row.expected);
    });
  }

  const matchRows: Array<{ name: string; input: unknown; expected?: string; result: boolean }> = [
    {
      name: "quoted id matches expected device",
      input: new Error("device 'emulator-5554' not found"),
      expected: "emulator-5554",
      result: true,
    },
    {
      name: "quoted id mismatched against expected device",
      input: new Error("device 'emulator-5554' not found"),
      expected: "other",
      result: false,
    },
    {
      name: "quoted id with no expectation",
      input: new Error("device 'emulator-5554' not found"),
      result: true,
    },
    {
      name: "generic 'device not found' with no expectation",
      input: new Error("device not found"),
      result: true,
    },
    {
      name: "generic 'no devices' with no expectation",
      input: new Error("adb: no devices/emulators found"),
      result: true,
    },
    {
      name: "generic message but a specific device expected",
      input: new Error("device not found"),
      expected: "emulator-5554",
      result: false,
    },
    {
      name: "unrelated error is never a missing-device error",
      input: new Error("offline"),
      result: false,
    },
  ];

  for (const row of matchRows) {
    test(`isAdbMissingDeviceError is ${row.result} for ${row.name}`, () => {
      expect(isAdbMissingDeviceError(row.input, row.expected)).toBe(row.result);
    });
  }
});
