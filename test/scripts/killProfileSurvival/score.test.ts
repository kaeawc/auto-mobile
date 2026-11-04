import { describe, expect, test } from "bun:test";
import { SURVIVAL_EVENT_IDS } from "../../../src/features/utility/KillProfileExpectedScores";
import { FIXTURE_PACKAGE, scoringWindow } from "../../../scripts/kill-profile-survival/matrix";
import { runHarness, type HarnessDeps } from "../../../scripts/kill-profile-survival/harness";
import { AvdGuardedAdb, parseCli } from "../../../scripts/kill-profile-survival/run";
import { KILL_PROFILE_IDS } from "../../../src/features/utility/KillProfiles";
import type { DeviceClockAdapter } from "../../../src/features/utility/DeviceClock";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceClockAdapter } from "../../fakes/FakeDeviceClockAdapter";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  DISPATCH_GRACE_MS,
  FOREGROUND_HEARTBEAT_MS,
  parseEvents,
  scoreEvents,
} from "../../../scripts/kill-profile-survival/score";

// All timestamps are supplied literals. No wall clock, device I/O or sleep is involved.
const START = 1_800_000_000_000;
const window = scoringWindow(START, START, START + 17 * 60_000, START + 24 * 60_000);

describe("survival scoring", () => {
  test("each event ran at its expected first interval, including the grace boundary", () => {
    const events = SURVIVAL_EVENT_IDS.map((eventId) => ({
      eventId,
      epochMillis: window.timing[eventId].firstDueMs + DISPATCH_GRACE_MS,
    }));
    for (const outcome of Object.values(scoreEvents(events, window))) {
      expect(outcome).toBe("ran");
    }
  });

  test("each event is delayed beyond its expected first interval", () => {
    const events = SURVIVAL_EVENT_IDS.map((eventId) => ({
      eventId,
      epochMillis: window.timing[eventId].firstDueMs + DISPATCH_GRACE_MS + 1,
    }));
    for (const outcome of Object.values(scoreEvents(events, window))) {
      expect(outcome).toBe("delayed");
    }
  });

  test("recovery-only work is delayed, including the exact deferral boundary", () => {
    const events = SURVIVAL_EVENT_IDS.map((eventId) => ({
      eventId,
      epochMillis: window.deferralMs,
    }));
    for (const outcome of Object.values(scoreEvents(events, window))) {
      expect(outcome).toBe("delayed");
    }
  });

  test("absent events and events outside the inclusive window are never", () => {
    const events = SURVIVAL_EVENT_IDS.flatMap((eventId) => [
      { eventId, epochMillis: START - 1 },
      { eventId, epochMillis: window.endMs + 1 },
    ]);
    for (const outcome of Object.values(scoreEvents(events, window))) {
      expect(outcome).toBe("never");
    }
    expect(scoreEvents([], window)["alarm-exact"]).toBe("never");
  });

  test("late repeated heartbeats are delayed, sorting input without mutating it", () => {
    const first = START + FOREGROUND_HEARTBEAT_MS;
    const events = parseEvents(
      `foreground-service ${first + FOREGROUND_HEARTBEAT_MS + DISPATCH_GRACE_MS + 1}\nforeground-service ${first}\n`,
    );
    const before = [...events];
    expect(scoreEvents(events, window)["foreground-service"]).toBe("delayed");
    expect(events).toEqual(before);
  });

  test("recovery does not erase an on-time run, and end boundary counts as delayed", () => {
    const events = parseEvents(`alarm-exact ${window.endMs}\npush-broadcast ${START}\r\n`);
    const score = scoreEvents(events, window);
    expect(score["alarm-exact"]).toBe("delayed");
    expect(score["push-broadcast"]).toBe("ran");
  });

  test("parser rejects unknown ids, malformed rows and unsafe timestamps", () => {
    expect(parseEvents("\n")).toEqual([]);
    for (const log of ["unknown 10", "alarm-exact nope", "alarm-exact 9007199254740992"]) {
      expect(() => parseEvents(log)).toThrow("Invalid survival event");
    }
  });

  test("rejects invalid window order", () => {
    expect(() => scoreEvents([], { ...window, endMs: START })).toThrow("Scoring window");
  });
});

function harnessFakes() {
  const fakeTimer = new FakeTimer();
  fakeTimer.setCurrentTime(START);
  const timer = {
    now: () => fakeTimer.now(),
    sleep(ms: number) {
      const pending = fakeTimer.sleep(ms);
      fakeTimer.advanceTime(ms);
      return pending;
    },
  };
  const baseClock = new FakeDeviceClockAdapter();
  baseClock.instantMs = START;
  let anchor = START;
  const clock: DeviceClockAdapter = {
    canRoot: () => baseClock.canRoot(),
    ensureRoot: () => baseClock.ensureRoot(),
    unroot: () => baseClock.unroot(),
    readAutomaticTime: () => baseClock.readAutomaticTime(),
    setAutomaticTime: (value) => baseClock.setAutomaticTime(value),
    async readInstantMs() {
      return (await baseClock.readInstantMs()) + fakeTimer.now() - anchor;
    },
    async setInstantMs(value) {
      await baseClock.setInstantMs(value);
      anchor = fakeTimer.now();
    },
  };
  const shell = new FakeAdbExecutor();
  shell.setAndroidApiLevel(37);
  shell.setCommandResponse("shell getprop ro.build.version.sdk", createExecResult("37", ""));
  shell.setCommandResponse(
    "shell pm path",
    createExecResult("package:/data/app/fixture/base.apk", ""),
  );
  shell.setCommandResponse("install ", createExecResult("Success", ""));
  shell.setCommandResponse("shell dumpsys battery", createExecResult("AC powered: true", ""));
  shell.setCommandResponse("shell am get-standby-bucket", createExecResult("10", ""));
  shell.setCommandResponse("shell appops get", createExecResult("No operations.", ""));
  shell.setCommandResponse("sh -c", createExecResult(String(START + 3_000), ""));
  return { deps: { shell, clock, timer }, shell, baseClock, fakeTimer };
}

describe("survival host safeguards with fakes", () => {
  test("CLI refuses missing targets, reserved serial, iPhone and output outside scratch", () => {
    for (const args of [
      [],
      ["--serial", "emulator-5554", "--avd", "Survival", "--out", "scratch/result.json"],
      ["--serial", "emulator-5556", "--avd", "iPhone", "--out", "scratch/result.json"],
      ["--serial", "iPhone-1", "--avd", "Survival", "--out", "scratch/result.json"],
      ["--serial", "emulator-5556", "--avd", "Survival", "--out", "scratch/../outside.json"],
    ]) {
      expect(() => parseCli(args)).toThrow();
    }
  });

  test("AVD identity precedes every operation and a mismatch prevents the write", async () => {
    const calls: string[][] = [];
    let avd = "Survival";
    const adb = new AvdGuardedAdb("emulator-5556", avd, {
      async run(args) {
        calls.push(args);
        return { stdout: args.includes("emu") ? `${avd}\r\nOK\r\n` : "done", stderr: "" };
      },
    });
    await adb.executeCommand("shell id");
    await adb.executeCommand("root");
    avd = "SomeoneElse";
    await expect(adb.executeCommand("shell am force-stop example")).rejects.toThrow("mismatch");
    expect(calls).toEqual([
      ["-s", "emulator-5556", "emu", "avd", "name"],
      ["-s", "emulator-5556", "shell", "id"],
      ["-s", "emulator-5556", "emu", "avd", "name"],
      ["-s", "emulator-5556", "root"],
      ["-s", "emulator-5556", "emu", "avd", "name"],
    ]);
  });

  test("read failure restores profile, clock and installation without real sleeps", async () => {
    const { deps, shell, baseClock, fakeTimer } = harnessFakes();
    shell.setCommandError("cat files/survival-events.log", new Error("read failed"));
    const report = await runHarness(
      { serial: "emulator-5556", avd: "Survival", apk: "fixture.apk" },
      deps,
    );
    expect(report.aborted).toContain("read failed");
    const commands = shell.getExecutedCommands();
    expect(commands).toContain("shell dumpsys battery reset");
    expect(commands).toContain("shell dumpsys deviceidle unforce");
    expect(commands).toContain(`shell am set-standby-bucket '${FIXTURE_PACKAGE}' 10`);
    expect(commands.at(-1)).toBe(`uninstall ${FIXTURE_PACKAGE}`);
    expect(baseClock.automaticTime).toBe(1);
    expect(baseClock.calls).toContain("unroot");
    expect(fakeTimer.getSleepHistory().reduce((sum, ms) => sum + ms, 0)).toBe(19 * 60_000);
    expect(report.results).toEqual([]);
  });

  test("one restore failure still attempts the clock reset and uninstall", async () => {
    const { deps, shell, baseClock } = harnessFakes();
    shell.setCommandError("cat files/survival-events.log", new Error("read failed"));
    shell.setCommandError("shell dumpsys battery reset", new Error("restore failed"));
    const report = await runHarness(
      { serial: "emulator-5556", avd: "Survival", apk: "fixture.apk" },
      deps,
    );
    expect(report.aborted).toContain("cleanup failed");
    expect(shell.getExecutedCommands().at(-1)).toBe(`uninstall ${FIXTURE_PACKAGE}`);
    expect(baseClock.automaticTime).toBe(1);
    expect(baseClock.calls).toContain("unroot");
    expect(report.results).toEqual([]);
  });

  test("preinstalled fixture is refused before any device changes", async () => {
    const { deps, shell, baseClock } = harnessFakes();
    shell.setCommandResponse(
      "shell pm list packages",
      createExecResult(`package:${FIXTURE_PACKAGE}`, ""),
    );
    const report = await runHarness(
      { serial: "emulator-5556", avd: "Survival", apk: "fixture.apk" },
      deps,
    );
    expect(report.aborted).toContain("already installed");
    expect(shell.getExecutedCommands()).toHaveLength(1);
    expect(baseClock.calls).toEqual([]);
  });

  test("cancelling observation restores without passing the aborted signal to cleanup", async () => {
    const { deps, shell, baseClock } = harnessFakes();
    const cancellation = new AbortController();
    const report = await runHarness(
      { serial: "emulator-5556", avd: "Survival", apk: "fixture.apk" },
      {
        ...deps,
        signal: cancellation.signal,
        shell: {
          async executeCommand(command, options) {
            if (command === "shell dumpsys deviceidle force-idle") {
              cancellation.abort(new Error("test cancellation"));
            }
            expect(options?.signal?.aborted).not.toBe(true);
            return shell.executeCommand(command, options);
          },
        },
      },
    );
    expect(report.aborted).toContain("test cancellation");
    expect(shell.getExecutedCommands()).toContain("shell dumpsys battery reset");
    expect(shell.getExecutedCommands().at(-1)).toBe(`uninstall ${FIXTURE_PACKAGE}`);
    expect(baseClock.automaticTime).toBe(1);
    expect(baseClock.calls).toContain("unroot");
  });

  test("older API cannot silently turn an unsupported profile into a score", async () => {
    const { deps, shell, baseClock } = harnessFakes();
    shell.setAndroidApiLevel(29);
    const report = await runHarness(
      { serial: "emulator-5556", avd: "Survival", apk: "fixture.apk" },
      deps,
    );
    expect(report.aborted).toContain("API 31+");
    expect(baseClock.calls).toEqual([]);
    expect(shell.getExecutedCommands()).toHaveLength(1);
  });

  test("complete matrix scores every profile and restores between runs using only fake time", async () => {
    const { deps, shell, baseClock, fakeTimer } = harnessFakes();
    const runningDeps: HarnessDeps = {
      ...deps,
      shell: {
        async executeCommand(command, options) {
          if (command.includes("sh -c")) {
            return createExecResult(String(await deps.clock.readInstantMs()), "");
          }
          return shell.executeCommand(command, options);
        },
      },
    };
    const report = await runHarness(
      { serial: "emulator-5556", avd: "Survival", apk: "fixture.apk" },
      runningDeps,
    );
    expect(report.aborted).toBeUndefined();
    expect(report.results.map((result) => result.profileId)).toEqual([...KILL_PROFILE_IDS]);
    for (const result of report.results) {
      expect(Object.values(result.score)).toEqual(SURVIVAL_EVENT_IDS.map(() => "never"));
      expect(result.pendingMeasurement).toEqual([...SURVIVAL_EVENT_IDS]);
      expect(result.mismatches).toEqual([]);
    }
    expect(
      shell.getExecutedCommands().filter((command) => command === `uninstall ${FIXTURE_PACKAGE}`),
    ).toHaveLength(10);
    expect(baseClock.calls.filter((call) => call === "unroot")).toHaveLength(10);
    expect(fakeTimer.getSleepHistory().reduce((sum, ms) => sum + ms, 0)).toBe(10 * 19 * 60_000);
  });
});
