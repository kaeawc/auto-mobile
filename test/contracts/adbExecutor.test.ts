import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import type { BootedDevice, ExecResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { runAdbExecutorContract, type ScriptedAdb } from "./AdbExecutorContract";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  isEmulator: true,
  name: "Test Device",
};

function execResult(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

function scriptedFake(): ScriptedAdb {
  const fake = new FakeAdbExecutor();
  fake.setThrowOnAbortedSignal(true);
  return {
    adb: fake,
    script: (pattern, output) =>
      fake.setCommandResponse(pattern, execResult(output.stdout, output.stderr ?? "")),
    scriptFailure: (pattern, error) => fake.setCommandError(pattern, error),
    scriptApiLevel: (level) => fake.setAndroidApiLevel(level),
    scriptWakefulness: (state) => fake.setScreenState(state === "Awake", state),
    scriptDeviceTimeMs: (timestampMs) => fake.setDeviceTimestampMs(timestampMs),
    scriptDeviceTimeSeconds: (seconds) => {
      fake.setDeviceTimestampMs(seconds * 1000);
      fake.setDeviceTimestampSource("device-seconds");
    },
    scriptDeviceTimeUnavailable: () => fake.setDeviceTimestampMs(null),
  };
}

// The real client runs with its process execution stubbed: no adb binary, no device.
function scriptedReal(): ScriptedAdb {
  const responses: Array<{ pattern: string; result?: ExecResult; error?: Error }> = [];
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(1_700_000_000_000);
  const client = new AdbClient(
    DEVICE,
    async (command: string) => {
      const match = responses.find((entry) => command.includes(entry.pattern));
      if (match?.error) {
        throw match.error;
      }
      return match?.result ?? execResult("");
    },
    null,
    new DefaultRetryExecutor(timer),
    timer,
  );
  const script: ScriptedAdb["script"] = (pattern, output) => {
    responses.unshift({ pattern, result: execResult(output.stdout, output.stderr ?? "") });
  };
  return {
    adb: client,
    script,
    scriptFailure: (pattern, error) => {
      responses.unshift({ pattern, error });
    },
    scriptApiLevel: (level) =>
      script("getprop ro.build.version.sdk", { stdout: level === null ? "" : `${level}\n` }),
    scriptWakefulness: (state) => script("mWakefulness=", { stdout: `mWakefulness=${state}\n` }),
    scriptDeviceTimeMs: (timestampMs) => script("date +%s%3N", { stdout: `${timestampMs}\n` }),
    scriptDeviceTimeSeconds: (seconds) => {
      // `date +%s` is a prefix of the millisecond command, so script it first (later wins).
      script("date +%s", { stdout: `${seconds}\n` });
      script("date +%s%3N", { stdout: "%3N\n" });
    },
    scriptDeviceTimeUnavailable: () => {
      responses.unshift({ pattern: "date +%s", error: new Error("no clock") });
    },
  };
}

runAdbExecutorContract("FakeAdbExecutor", scriptedFake);
runAdbExecutorContract("AdbClient (stubbed process execution)", scriptedReal);
