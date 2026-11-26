import { expect, test } from "bun:test";
import {
  bootTeardownDeviceLeft,
  bootTeardownDeviceLeftFor,
  markBootTeardown,
} from "../../src/devices/bootTeardownDeviceLeft";

test("a confirmed or still-running stop reports shutdown; an unconfirmed one unknown (#19368)", () => {
  expect(bootTeardownDeviceLeftFor("confirmed")).toBe("shutdown");
  expect(bootTeardownDeviceLeftFor("pending")).toBe("shutdown");
  expect(bootTeardownDeviceLeftFor("survived")).toBe("unknown");
  expect(bootTeardownDeviceLeftFor("cleanup-unconfirmed")).toBe("unknown");
  expect(bootTeardownDeviceLeftFor("unobservable")).toBe("unknown");
});

test("the teardown is read back from the failure that carries it, and only from it (#19368)", () => {
  const failure = new Error("boot timed out");
  expect(markBootTeardown(failure, "shutdown")).toBe(failure);
  expect(failure.message).toBe("boot timed out");
  expect(bootTeardownDeviceLeft(failure)).toBe("shutdown");
  expect(bootTeardownDeviceLeft(new Error("boot timed out"))).toBeUndefined();
  expect(markBootTeardown(null, "shutdown")).toBeNull();
  expect(bootTeardownDeviceLeft(null)).toBeUndefined();
  expect(bootTeardownDeviceLeft("boot timed out")).toBeUndefined();
});
