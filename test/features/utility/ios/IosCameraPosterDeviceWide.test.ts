import { expect, test } from "bun:test";
import type { ExecResult } from "../../../../src/models";
import {
  IosCameraPosterDeviceWide,
  type PosterSimctlRunner,
} from "../../../../src/features/utility/ios/IosCameraPosterDeviceWide";
import { FakeIosCameraPosterDylibProvider } from "../../../fakes/FakeIosCameraPoster";

const udid = "A1B2C3D4-0000-4000-8000-000000000001";

class FakeLaunchctl implements PosterSimctlRunner {
  readonly calls: string[][] = [];
  dyldInsertLibraries = "";
  async executeCommandArgs(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    const stdout = args[3] === "getenv" ? `${this.dyldInsertLibraries}\n` : "";
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (s) => stdout.includes(s),
    };
  }
}

function setup() {
  const simctl = new FakeLaunchctl();
  const poster = new FakeIosCameraPosterDylibProvider();
  const gate = new FakeIosCameraPosterDylibProvider();
  gate.path = "/camera/libAMCameraPosterGate.dylib";
  const deviceWide = new IosCameraPosterDeviceWide(simctl, poster, gate, {
    path: (id) => `/data/devices/${id}.json`,
  });
  return { simctl, poster, gate, deviceWide };
}

test("sets the poster library and config before inserting the gate into launchd", async () => {
  const h = setup();
  await h.deviceWide.activate(udid);
  expect(h.simctl.calls).toEqual([
    ["spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    [
      "spawn",
      udid,
      "launchctl",
      "setenv",
      "AM_CAMERA_POSTER_DYLIB",
      "/camera/libAMCameraPoster.dylib",
    ],
    ["spawn", udid, "launchctl", "setenv", "AM_CAMERA_POSTER_CONFIG", `/data/devices/${udid}.json`],
    [
      "spawn",
      udid,
      "launchctl",
      "setenv",
      "DYLD_INSERT_LIBRARIES",
      "/camera/libAMCameraPosterGate.dylib",
    ],
  ]);
});

test("keeps libraries another feature already inserted and does not add the gate twice", async () => {
  const h = setup();
  h.simctl.dyldInsertLibraries = "/shaper/libShaper.dylib:/camera/libAMCameraPosterGate.dylib";
  await h.deviceWide.activate(udid);
  expect(h.simctl.calls.at(-1)).toEqual([
    "spawn",
    udid,
    "launchctl",
    "setenv",
    "DYLD_INSERT_LIBRARIES",
    "/shaper/libShaper.dylib:/camera/libAMCameraPosterGate.dylib",
  ]);
});

test("a library that cannot be built fails before launchd is touched", async () => {
  const h = setup();
  h.gate.error = new Error("no clang");
  await expect(h.deviceWide.activate(udid)).rejects.toThrow("no clang");
  expect(h.simctl.calls).toEqual([]);
});
