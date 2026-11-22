import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { runExecSeam, type ExecSeamOptions } from "../../../src/utils/ExecSeam";
import {
  REDACTED_COMMAND_ARG,
  TRUNCATED_OUTPUT_MARKER,
  type ToolCallCapture,
} from "../../../src/utils/fixtureCapture/fixtureCaptureFormat";
import { logger } from "../../../src/utils/logger";
import {
  fixtureCaptureFromEnv,
  resolveCaptureDirectory,
  withToolCallCapture,
} from "../../../src/utils/fixtureCapture/fixtureCaptureFromEnv";
import { DirectoryFixtureCaptureWriter } from "../../../src/utils/fixtureCapture/FixtureCaptureWriter";
import type { FixtureCaptureWriter } from "../../../src/utils/fixtureCapture/FixtureCaptureWriter";
import {
  beginCapturedCommand,
  noteFixtureCaptureDevice,
  outsideFixtureCapture,
  runWithFixtureCapture,
  withFixtureCaptureRedaction,
  withFixtureCaptureScrub,
  type CaptureSourceIdentity,
  type FixtureCaptureDeps,
} from "../../../src/utils/fixtureCapture/fixtureCaptureScope";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeCaptureWriter implements FixtureCaptureWriter {
  readonly captures: ToolCallCapture[] = [];
  async write(capture: ToolCallCapture): Promise<void> {
    this.captures.push(capture);
  }
}

function captureDeps(): { deps: FixtureCaptureDeps; writer: FakeCaptureWriter; timer: FakeTimer } {
  const writer = new FakeCaptureWriter();
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.UTC(2026, 10, 19, 12, 0, 0));
  const sourceIdentity = async () => ({
    automobileVersion: "0.0.96+gabc1234",
    sourceTreeState: "clean" as const,
  });
  return { deps: { writer, timer, sourceIdentity }, writer, timer };
}

/** Runs one command through the real exec seam; `advanceMs` is how long it "takes". */
function seamCommand(
  timer: FakeTimer,
  args: string[],
  outcome: { stdout: string; stderr: string } | Error,
  advanceMs = 0,
): Promise<unknown> {
  return runExecSeam(
    async (_options: ExecSeamOptions) => {
      timer.advanceTime(advanceMs);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
    {},
    { command: "adb", args },
    { preserveError: true },
  );
}

function execError(fields: { code?: number | string; stdout?: string; stderr?: string }): Error {
  return Object.assign(new Error("Command failed"), fields);
}

const device: BootedDevice = {
  name: "Pixel_9_API_36",
  platform: "android",
  deviceId: "emulator-5554",
  apiLevel: 36,
  formFactor: "phone",
  model: "sdk_gphone64_arm64",
};

describe("fixture capture scope", () => {
  test("is inert without deps: no capture handle and the seam result is unchanged", async () => {
    const { timer } = captureDeps();
    const result = await runWithFixtureCapture("observe", undefined, async () => {
      expect(beginCapturedCommand(["adb"])).toBeUndefined();
      return seamCommand(timer, ["devices"], { stdout: "out", stderr: "" });
    });
    expect(String(result)).toBe("out");
    expect(beginCapturedCommand(["adb"])).toBeUndefined();
  });

  test("records argv, output, exit code and duration for each seam command", async () => {
    const { deps, writer, timer } = captureDeps();
    await runWithFixtureCapture("observe", deps, async () => {
      noteFixtureCaptureDevice(device);
      await seamCommand(
        timer,
        ["-s", "emulator-5554", "shell", "getprop"],
        {
          stdout: "[ro.build.version.sdk]: [36]\n",
          stderr: "",
        },
        42,
      );
    });
    expect(writer.captures).toHaveLength(1);
    const [capture] = writer.captures;
    expect(capture?.provenance).toEqual({
      schemaVersion: 1,
      tool: { name: "observe" },
      captureDate: "2026-11-19T12:00:00.000Z",
      automobileVersion: "0.0.96+gabc1234",
      sourceTreeState: "clean",
      device: {
        platform: "android",
        deviceId: "emulator-5554",
        name: "Pixel_9_API_36",
        apiLevel: 36,
        formFactor: "phone",
        model: "sdk_gphone64_arm64",
      },
    });
    expect(capture?.commands).toEqual([
      {
        index: 0,
        argv: ["adb", "-s", "emulator-5554", "shell", "getprop"],
        exitCode: 0,
        durationMs: 42,
        stdout: "[ro.build.version.sdk]: [36]\n",
        stderr: "",
      },
    ]);
  });

  test("fills the device's missing OS and model facts from the admitted image", async () => {
    const { deps, writer } = captureDeps();
    await runWithFixtureCapture("rotate", deps, async () => {
      noteFixtureCaptureDevice(
        { platform: "android", deviceId: "emulator-5582", name: "fold", formFactor: "foldable" },
        {
          name: "fold",
          platform: "android",
          isRunning: true,
          apiLevel: 36,
          osVersion: "16",
          formFactor: "phone",
          model: "sdk_gphone64_arm64",
        },
      );
    });
    expect(writer.captures[0]?.provenance.device).toEqual({
      platform: "android",
      deviceId: "emulator-5582",
      name: "fold",
      formFactor: "foldable",
      apiLevel: 36,
      osVersion: "16",
      model: "sdk_gphone64_arm64",
    });
  });

  test("records a failed command's exit code and output, and the seam still throws", async () => {
    const { deps, writer, timer } = captureDeps();
    const failure = execError({ code: 1, stdout: "partial", stderr: "error: closed" });
    await runWithFixtureCapture("observe", deps, async () => {
      await expect(seamCommand(timer, ["shell", "x"], failure)).rejects.toBe(failure);
      await expect(
        seamCommand(timer, ["shell", "y"], execError({ code: "ENOENT" })),
      ).rejects.toThrow();
    });
    const commands = writer.captures[0]?.commands;
    expect(commands?.[0]).toMatchObject({
      exitCode: 1,
      stdout: "partial",
      stderr: "error: closed",
    });
    expect(commands?.[1]).toMatchObject({ exitCode: null, errorCode: "ENOENT", stdout: "" });
  });

  test("writes the capture when the tool call throws", async () => {
    const { deps, writer, timer } = captureDeps();
    await expect(
      runWithFixtureCapture("tapOn", deps, async () => {
        await seamCommand(timer, ["shell", "input", "tap", "1", "2"], { stdout: "", stderr: "" });
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");
    expect(writer.captures[0]?.commands).toHaveLength(1);
  });

  test("replaces argv of a command run under a redaction label", async () => {
    const { deps, writer, timer } = captureDeps();
    await runWithFixtureCapture("sendKeys", deps, () =>
      withFixtureCaptureRedaction("shell input <password>", () =>
        seamCommand(timer, ["shell", "input", "text", "hunter2"], { stdout: "", stderr: "" }),
      ),
    );
    expect(writer.captures[0]?.commands[0]).toMatchObject({
      argv: ["adb", REDACTED_COMMAND_ARG],
      redacted: true,
    });
  });

  test("indexes concurrent commands in the order they started, not finished", async () => {
    const { deps, writer } = captureDeps();
    const ok = { stdout: "", stderr: "" };
    await runWithFixtureCapture("listApps", deps, async () => {
      const first = beginCapturedCommand(["adb", "first"]);
      const second = beginCapturedCommand(["adb", "second"]);
      second?.finish(ok);
      first?.finish(ok);
    });
    expect(
      writer.captures[0]?.commands.map((cmd) => ({ index: cmd.index, arg: cmd.argv[1] })),
    ).toEqual([
      { index: 0, arg: "first" },
      { index: 1, arg: "second" },
    ]);
  });

  test("attributes each command to the innermost tool call", async () => {
    const { deps, writer, timer } = captureDeps();
    const ok = { stdout: "", stderr: "" };
    await runWithFixtureCapture("executePlan", deps, async () => {
      await seamCommand(timer, ["outer-before"], ok);
      await runWithFixtureCapture("observe", deps, () => seamCommand(timer, ["inner"], ok));
      await seamCommand(timer, ["outer-after"], ok);
    });
    const byTool = Object.fromEntries(
      writer.captures.map((c) => [c.provenance.tool.name, c.commands.map((cmd) => cmd.argv[1])]),
    );
    expect(byTool).toEqual({ observe: ["inner"], executePlan: ["outer-before", "outer-after"] });
  });

  test("a repeating sampler armed in a call records nothing once the call is written", async () => {
    const { deps, writer, timer } = captureDeps();
    const ok = { stdout: "tick", stderr: "" };
    const handles: unknown[] = [];
    let straggler: ReturnType<typeof beginCapturedCommand>;
    await runWithFixtureCapture("observe", deps, async () => {
      // A real timer keeps the arming call's async context; bind models that on FakeTimer.
      timer.setInterval(
        AsyncLocalStorage.bind(() => {
          handles.push(beginCapturedCommand(["adb", "shell", "dumpsys"]));
          void seamCommand(timer, ["shell", "dumpsys"], ok);
        }),
        500,
      );
      straggler = beginCapturedCommand(["adb", "slow"]);
      await seamCommand(timer, ["in-call"], ok);
    });
    const written = writer.captures[0]?.commands;
    expect(written?.map((command) => command.argv[1])).toEqual(["in-call"]);
    straggler?.finish(ok);
    timer.advanceTime(1500);
    await Promise.resolve();
    expect(handles).toEqual([undefined, undefined, undefined]);
    expect(written).toHaveLength(1);
    expect(writer.captures).toHaveLength(1);
  });

  test("outsideFixtureCapture hides the scope from work it runs", async () => {
    const { deps, writer, timer } = captureDeps();
    await runWithFixtureCapture("observe", deps, async () => {
      expect(outsideFixtureCapture(() => beginCapturedCommand(["adb"]))).toBeUndefined();
      await outsideFixtureCapture(() =>
        seamCommand(timer, ["background"], { stdout: "", stderr: "" }),
      );
    });
    expect(writer.captures[0]?.commands).toEqual([]);
  });

  test("cuts a stream at the per-command limit and the rest at the per-call limit", async () => {
    const { deps, writer, timer } = captureDeps();
    const limited = { ...deps, limits: { streamChars: 4, callChars: 6 } };
    await runWithFixtureCapture("observe", limited, async () => {
      await seamCommand(timer, ["a"], { stdout: "abcdefgh", stderr: "" });
      await seamCommand(timer, ["b"], { stdout: "xy", stderr: "zzz" });
      await seamCommand(timer, ["c"], { stdout: "", stderr: "" });
    });
    const commands = writer.captures[0]?.commands;
    expect(
      commands?.map(({ stdout, stderr, truncated }) => ({ stdout, stderr, truncated })),
    ).toEqual([
      { stdout: `abcd${TRUNCATED_OUTPUT_MARKER}`, stderr: "", truncated: true },
      { stdout: "xy", stderr: TRUNCATED_OUTPUT_MARKER, truncated: true },
      { stdout: "", stderr: "", truncated: undefined },
    ]);
    expect(commands?.[2]?.argv).toEqual(["adb", "c"]);
  });

  test("spends the per-call limit in issue order when commands finish out of order", async () => {
    const { deps, writer } = captureDeps();
    const limited = { ...deps, limits: { streamChars: 10, callChars: 6 } };
    await runWithFixtureCapture("listApps", limited, async () => {
      const first = beginCapturedCommand(["adb", "first"]);
      const second = beginCapturedCommand(["adb", "second"]);
      second?.finish({ stdout: "22222", stderr: "" });
      first?.finish({ stdout: "11111", stderr: "" });
    });
    expect(
      writer.captures[0]?.commands.map(({ argv, stdout, truncated }) => ({
        arg: argv[1],
        stdout,
        truncated,
      })),
    ).toEqual([
      { arg: "first", stdout: "11111", truncated: undefined },
      { arg: "second", stdout: `2${TRUNCATED_OUTPUT_MARKER}`, truncated: true },
    ]);
  });

  test("marks a command that overflowed node's maxBuffer truncated at any output length", async () => {
    const { deps, writer, timer } = captureDeps();
    const limited = { ...deps, limits: { streamChars: 4, callChars: 100 } };
    const overflow = execError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "abcd" });
    await runWithFixtureCapture("observe", limited, async () => {
      await expect(seamCommand(timer, ["shell", "dumpsys"], overflow)).rejects.toBe(overflow);
    });
    expect(writer.captures[0]?.commands[0]).toMatchObject({
      exitCode: null,
      errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stdout: "abcd",
      truncated: true,
    });
  });

  test("applies a caller's scrubber before truncation and marks the command redacted", async () => {
    const { deps, writer, timer } = captureDeps();
    const scrub = (value: string) => value.split("s3cret").join("<redacted>");
    const limited = { ...deps, limits: { streamChars: 20, callChars: 100 } };
    await runWithFixtureCapture("installApp", limited, () =>
      withFixtureCaptureScrub(scrub, async () => {
        await seamCommand(timer, ["--pass=s3cret"], { stdout: "", stderr: "bad pass s3cret!" });
        await seamCommand(timer, ["clean"], { stdout: "ok", stderr: "" });
      }),
    );
    const [scrubbed, clean] = writer.captures[0]?.commands ?? [];
    expect(scrubbed).toMatchObject({
      argv: ["adb", "--pass=<redacted>"],
      stderr: "bad pass <redacted>!",
      redacted: true,
    });
    expect(clean?.redacted).toBeUndefined();
  });

  test("awaits the settled source identity, and records unknown when it fails", async () => {
    const { deps, writer } = captureDeps();
    const pending = Promise.withResolvers<CaptureSourceIdentity>();
    const settled = runWithFixtureCapture(
      "observe",
      { ...deps, sourceIdentity: () => pending.promise },
      async () => "done",
    );
    await Promise.resolve();
    expect(writer.captures).toHaveLength(0);
    pending.resolve({ automobileVersion: "0.0.96+gabc1234.dirty.0123", sourceTreeState: "dirty" });
    expect(await settled).toBe("done");
    expect(writer.captures[0]?.provenance.sourceTreeState).toBe("dirty");

    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await runWithFixtureCapture(
        "observe",
        { ...deps, sourceIdentity: () => Promise.reject(new Error("git timed out")) },
        async () => undefined,
      );
    } finally {
      warn.mockRestore();
    }
    expect(writer.captures[1]?.provenance).toMatchObject({
      automobileVersion: "unknown",
      sourceTreeState: "unknown",
    });
  });
});

describe("fixtureCaptureFromEnv", () => {
  test("is off when the variable is unset or blank", () => {
    expect(fixtureCaptureFromEnv({})).toBeUndefined();
    expect(fixtureCaptureFromEnv({ AUTOMOBILE_CAPTURE_FIXTURES_DIR: "  " })).toBeUndefined();
  });

  test("a wrapped tool handler opens no capture scope while the variable is unset", async () => {
    const wrapped = withToolCallCapture(
      "observe",
      async (value: number) => ({ value, handle: beginCapturedCommand(["adb"]) }),
      {},
    );
    expect(await wrapped(7)).toEqual({ value: 7, handle: undefined });
  });

  test("writes to the named directory when set", () => {
    const deps = fixtureCaptureFromEnv({ AUTOMOBILE_CAPTURE_FIXTURES_DIR: "/tmp/capture" });
    expect(deps?.writer).toBeInstanceOf(DirectoryFixtureCaptureWriter);
  });
});

describe("resolveCaptureDirectory", () => {
  test("resolves a relative directory against the working directory and keeps an absolute one", () => {
    const cwd = path.resolve("/daemon/cwd");
    const absolute = path.resolve("/abs/captures");
    expect(resolveCaptureDirectory("captures", cwd)).toBe(path.join(cwd, "captures"));
    expect(resolveCaptureDirectory(absolute, cwd)).toBe(absolute);
  });
});
