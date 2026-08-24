import { describe, expect, test } from "bun:test";
import { requireBootedDevice } from "../../src/utils/requireBootedDevice";

const FN = "Test.getInstance";

describe("requireBootedDevice", () => {
  test("throws on a bare deviceId string", () => {
    expect(() => requireBootedDevice("emulator-5554", FN)).toThrow(
      `${FN}: expected BootedDevice, got string "emulator-5554"`,
    );
  });

  test("throws on empty object", () => {
    expect(() => requireBootedDevice({}, FN)).toThrow(/expected BootedDevice/);
  });

  test("throws on null", () => {
    expect(() => requireBootedDevice(null, FN)).toThrow(/expected BootedDevice/);
  });

  test("throws on undefined", () => {
    expect(() => requireBootedDevice(undefined, FN)).toThrow(/expected BootedDevice/);
  });

  test("throws on missing deviceId", () => {
    expect(() => requireBootedDevice({ platform: "android", name: "x" }, FN)).toThrow(
      /expected BootedDevice/,
    );
  });

  test("throws on empty deviceId", () => {
    expect(() => requireBootedDevice({ platform: "android", name: "x", deviceId: "" }, FN)).toThrow(
      /expected BootedDevice/,
    );
  });

  test("throws on missing platform", () => {
    expect(() => requireBootedDevice({ deviceId: "emulator-5554", name: "x" }, FN)).toThrow(
      /expected BootedDevice/,
    );
  });

  test("throws on invalid platform", () => {
    expect(() =>
      requireBootedDevice({ deviceId: "emulator-5554", platform: "windows", name: "x" }, FN),
    ).toThrow(/expected BootedDevice/);
  });

  test("accepts a valid android BootedDevice", () => {
    expect(() =>
      requireBootedDevice({ deviceId: "emulator-5554", platform: "android", name: "Pixel" }, FN),
    ).not.toThrow();
  });

  test("accepts a valid ios BootedDevice", () => {
    expect(() =>
      requireBootedDevice({ deviceId: "ABCDEF", platform: "ios", name: "iPhone 15" }, FN),
    ).not.toThrow();
  });

  test("error includes function name and JSON-serialized object", () => {
    expect(() => requireBootedDevice({ foo: "bar" }, "MyFactory.getInstance")).toThrow(
      'MyFactory.getInstance: expected BootedDevice, got {"foo":"bar"}',
    );
  });

  test("still throws the guard error when input has a cyclic reference", () => {
    const cyclic: Record<string, unknown> = { foo: "bar" };
    cyclic.self = cyclic;
    expect(() => requireBootedDevice(cyclic, FN)).toThrow(
      new RegExp(`^${FN}: expected BootedDevice, got `),
    );
  });

  test("still throws the guard error when input contains a BigInt", () => {
    expect(() => requireBootedDevice({ deviceId: 5n, platform: "android" }, FN)).toThrow(
      new RegExp(`^${FN}: expected BootedDevice, got `),
    );
  });
});

describe("requireBootedDevice integration with factories", () => {
  test("IOSCtrlProxyClient.getInstance throws on bare deviceId string", async () => {
    const { IOSCtrlProxyClient } =
      await import("../../src/features/observe/ios/IOSCtrlProxyClient");
    expect(() => IOSCtrlProxyClient.getInstance("ABCDEF" as never)).toThrow(
      /IOSCtrlProxyClient\.getInstance: expected BootedDevice/,
    );
  });

  test("IOSCtrlProxyClient.getInstance throws on empty object", async () => {
    const { IOSCtrlProxyClient } =
      await import("../../src/features/observe/ios/IOSCtrlProxyClient");
    expect(() => IOSCtrlProxyClient.getInstance({} as never)).toThrow(/expected BootedDevice/);
  });

  test("AndroidCtrlProxyManager.getInstance throws on bare deviceId string", async () => {
    const { AndroidCtrlProxyManager } = await import("../../src/utils/CtrlProxyManager");
    expect(() => AndroidCtrlProxyManager.getInstance("emulator-5554" as never)).toThrow(
      /AndroidCtrlProxyManager\.getInstance: expected BootedDevice/,
    );
  });

  test("AndroidCtrlProxyManager.getInstance throws on empty object", async () => {
    const { AndroidCtrlProxyManager } = await import("../../src/utils/CtrlProxyManager");
    expect(() => AndroidCtrlProxyManager.getInstance({} as never)).toThrow(/expected BootedDevice/);
  });

  test("IOSCtrlProxyManager.getInstance throws on bare deviceId string", async () => {
    const { IOSCtrlProxyManager } = await import("../../src/utils/IOSCtrlProxyManager");
    expect(() => IOSCtrlProxyManager.getInstance("ABCDEF" as never)).toThrow(
      /IOSCtrlProxyManager\.getInstance: expected BootedDevice/,
    );
  });

  test("IOSCtrlProxyManager.getInstance throws on empty object", async () => {
    const { IOSCtrlProxyManager } = await import("../../src/utils/IOSCtrlProxyManager");
    expect(() => IOSCtrlProxyManager.getInstance({} as never)).toThrow(/expected BootedDevice/);
  });
});
