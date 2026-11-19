import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { runExecSeam, type ExecSeamOptions } from "../../../src/utils/ExecSeam";
import {
  REDACTED_COMMAND_ARG,
  type ToolCallCapture,
} from "../../../src/utils/fixtureCapture/fixtureCaptureFormat";
import {
  fixtureCaptureFromEnv,
  withToolCallCapture,
} from "../../../src/utils/fixtureCapture/fixtureCaptureFromEnv";
import { DirectoryFixtureCaptureWriter } from "../../../src/utils/fixtureCapture/FixtureCaptureWriter";
import type { FixtureCaptureWriter } from "../../../src/utils/fixtureCapture/FixtureCaptureWriter";
import {
  beginCapturedCommand,
  noteFixtureCaptureDevice,
  runWithFixtureCapture,
  withFixtureCaptureRedaction,
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
  return { deps: { writer, timer, automobileVersion: () => "0.0.96+gabc1234" }, writer, timer };
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
