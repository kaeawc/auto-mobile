import { expect, test } from "bun:test";
import {
  PsSimulatorBootEnvironment,
  findLaunchdSimPid,
  parseDyldInsertLibraries,
} from "../../../../src/features/utility/ios/SimulatorBootEnvironment";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";

const udid = "3258126D-C229-4B27-A3A1-D90E1B75CF78";
const runtime =
  "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.2.8117.0.ljtUZt/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.2.simruntime/Contents/Resources/RuntimeRoot";
// The shape `ps -axww -o pid=,command=` and `ps -E -ww -o command= -p` print on macOS 26 for an
// iOS 27.2 simulator booted with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES (home directory shortened).
const processes = [
  `75100 launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/OTHER-UDID/data/var/run/launchd_bootstrap.plist`,
  `78029 launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist`,
  `78044 ${runtime}/System/Library/CoreServices/SpringBoard.app/SpringBoard`,
].join("\n");
const environment = `launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist OSLogRateLimit=64 XPC_SERVICE_NAME=com.apple.CoreSimulator.SimDevice.${udid} PATH=${runtime}/usr/bin AM_PROBE_VAR=bootvalue DYLD_INSERT_LIBRARIES=/tmp/shaper/libShaper.dylib:/tmp/b.dylib DYLD_ROOT_PATH=${runtime}\n`;

test("finds the launchd_sim of the simulator, not another simulator's or its children", () => {
  expect(findLaunchdSimPid(processes, udid)).toBe("78029");
  expect(findLaunchdSimPid(processes, "MISSING")).toBeUndefined();
});

test("reads the boot-time DYLD_INSERT_LIBRARIES up to the next variable", () => {
  expect(parseDyldInsertLibraries(environment)).toBe("/tmp/shaper/libShaper.dylib:/tmp/b.dylib");
  expect(
    parseDyldInsertLibraries(`launchd_sim /x OSLogRateLimit=64 DYLD_ROOT_PATH=${runtime}`),
  ).toBe("");
});

test("reads launchd_sim's environment through ps, and reports none for a stopped simulator", async () => {
  const host = new FakeHostCommandExecutor();
  host.setCommandResponse("ps -axww -o pid=,command=", createExecResult(processes, ""));
  host.setCommandResponse("ps -E -ww -o command= -p 78029", createExecResult(environment, ""));
  const reader = new PsSimulatorBootEnvironment(host);
  expect(await reader.dyldInsertLibraries(udid)).toBe("/tmp/shaper/libShaper.dylib:/tmp/b.dylib");
  expect(await reader.dyldInsertLibraries("STOPPED")).toBe("");
});
