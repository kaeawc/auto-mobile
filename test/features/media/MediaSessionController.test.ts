import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AndroidMediaSessionController } from "../../../src/features/media/MediaSessionController";
import { volumeSetScript } from "../../../src/features/media/AndroidVolume";
import { shellQuote } from "../../../src/utils/shellQuote";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecResult } from "../../../src/models";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { wrappedAdbRejection } from "../../helpers/adbRejection";

// Hand-reconstructed dumps; see test/fixtures/android-media-session/README.md.
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-media-session/${name}.txt`, import.meta.url),
    "utf8",
  );
}

const PLAYING = fixture("dumpsys-media-session-api34-playing");
const PAUSED = fixture("dumpsys-media-session-api34-paused");
const IDLE = fixture("dumpsys-media-session-api34-idle");

type Reply = ExecResult | Error;

/** Answers each adb command from a per-command queue; the last reply repeats. */
class ScriptedAdb implements AdbCommandRunner {
  readonly commands: string[] = [];
  private readonly replies = new Map<string, Reply[]>();

  on(command: string, ...replies: Reply[]): this {
    this.replies.set(command, replies);
    return this;
  }

  dumps(...outputs: string[]): this {
    return this.on(
      "shell dumpsys media_session",
      ...outputs.map((out) => createExecResult(out, "")),
    );
  }

  async executeCommand(command: string, _options?: AdbExecuteOptions): Promise<ExecResult> {
    this.commands.push(command);
    const queue = this.replies.get(command);
    if (!queue || queue.length === 0) {
      throw new Error(`unscripted adb command: ${command}`);
    }
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

function controllerFor(adb: ScriptedAdb): {
  controller: AndroidMediaSessionController;
  timer: FakeTimer;
} {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return { controller: new AndroidMediaSessionController(adb, timer), timer };
}

const ok = (stdout = "") => createExecResult(stdout, "");

describe("AndroidMediaSessionController.getSessions", () => {
  test("filters sessions to appId but keeps the media button session", async () => {
    const { controller } = controllerFor(new ScriptedAdb().dumps(PLAYING));

    const dump = await controller.getSessions({ appId: "com.example.podcasts" });

    expect(dump.sessions.map((session) => session.package)).toEqual(["com.example.podcasts"]);
    expect(dump.mediaButtonSession?.package).toBe("dev.example.player");
  });

  test("a failing dumpsys becomes an ActionableError", async () => {
    const adb = new ScriptedAdb().on("shell dumpsys media_session", new Error("device offline"));
    const { controller } = controllerFor(adb);

    await expect(controller.getSessions({})).rejects.toBeInstanceOf(ActionableError);
  });
});

describe("AndroidMediaSessionController.waitForState", () => {
  test("polls until a session reports the state", async () => {
    const adb = new ScriptedAdb().dumps(IDLE, PAUSED, PLAYING);
    const { controller, timer } = controllerFor(adb);

    const result = await controller.waitForState({ mediaState: "playing", timeoutMs: 5000 });

    expect(result).toMatchObject({ mediaState: "playing", matched: true, polls: 3, waitMs: 500 });
    expect(timer.getSleepHistory()).toEqual([250, 250]);
  });

  test("times out with the last dump when the state never appears", async () => {
    const { controller } = controllerFor(new ScriptedAdb().dumps(PAUSED));

    const result = await controller.waitForState({
      appId: "dev.example.player",
      mediaState: "playing",
      timeoutMs: 600,
    });

    expect(result.matched).toBe(false);
    expect(result.waitMs).toBe(600);
    expect(result.polls).toBe(4);
    expect(result.dump.sessions[0].state).toBe("paused");
  });

  test("only matches sessions of appId", async () => {
    // The podcast session is paused; the player is playing.
    const { controller } = controllerFor(new ScriptedAdb().dumps(PLAYING));

    const result = await controller.waitForState({
      appId: "com.example.podcasts",
      mediaState: "playing",
      timeoutMs: 250,
    });

    expect(result.matched).toBe(false);
  });

  test("stops when the caller aborts", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    const { controller } = controllerFor(new ScriptedAdb().dumps(PAUSED));

    await expect(
      controller.waitForState({ mediaState: "playing", timeoutMs: 1000, signal: abort.signal }),
    ).rejects.toThrow("cancelled");
  });
});

describe("AndroidMediaSessionController.dispatch", () => {
  test("pause reaches the media button session and reports the transition and receipt", async () => {
    const adb = new ScriptedAdb()
      .dumps(PLAYING, PLAYING, PAUSED)
      .on("shell cmd media_session dispatch pause", ok());
    const { controller } = controllerFor(adb);

    const result = await controller.dispatch({ key: "pause", appId: "dev.example.player" });

    expect(result).toMatchObject({
      key: "pause",
      handledBy: { package: "dev.example.player", tag: "PlaybackService", userId: 0 },
      previousState: "playing",
      state: "paused",
      stateChanged: true,
      restore: { dispatch: "play" },
    });
    expect(adb.commands).toEqual([
      "shell dumpsys media_session",
      "shell cmd media_session dispatch pause",
      "shell dumpsys media_session",
      "shell dumpsys media_session",
    ]);
  });

  test.each(["next", "previous"] as const)(
    "%s reports the state change but withholds the restore receipt",
    async (key) => {
      const adb = new ScriptedAdb()
        .dumps(PLAYING, PLAYING, PAUSED)
        .on(`shell cmd media_session dispatch ${key}`, ok());
      const { controller } = controllerFor(adb);

      const result = await controller.dispatch({ key });

      expect(result.stateChanged).toBe(true);
      expect(result.previousState).toBe("playing");
      expect(result.restore).toBeUndefined();
    },
  );

  test("an unchanged state settles after the window with no receipt", async () => {
    const adb = new ScriptedAdb().dumps(PLAYING).on("shell cmd media_session dispatch play", ok());
    const { controller, timer } = controllerFor(adb);

    const result = await controller.dispatch({ key: "play" });

    expect(result.stateChanged).toBe(false);
    expect(result.state).toBe("playing");
    expect(result.restore).toBeUndefined();
    expect(timer.now()).toBeGreaterThanOrEqual(2000);
  });

  test("refuses, without dispatching, when appId is not the media button session", async () => {
    const adb = new ScriptedAdb().dumps(PLAYING);
    const { controller } = controllerFor(adb);

    await expect(
      controller.dispatch({ key: "pause", appId: "com.example.podcasts" }),
    ).rejects.toThrow(/media button session \(dev\.example\.player\/PlaybackService/);
    expect(adb.commands).toEqual(["shell dumpsys media_session"]);
  });

  test("with no media button session, reports the session that appears", async () => {
    const adb = new ScriptedAdb()
      .dumps(IDLE, IDLE, PLAYING)
      .on("shell cmd media_session dispatch play", ok());
    const { controller } = controllerFor(adb);

    const result = await controller.dispatch({ key: "play" });

    expect(result.handledBy?.package).toBe("dev.example.player");
    expect(result.previousState).toBeUndefined();
    expect(result.state).toBe("playing");
    expect(result.stateChanged).toBe(false);
  });

  test("falls back to the media shell tool when cmd has no media_session command", async () => {
    const adb = new ScriptedAdb()
      .dumps(PLAYING, PAUSED)
      .on("shell cmd media_session dispatch pause", ok("No shell command implementation."))
      .on("shell media dispatch pause", ok());
    const { controller } = controllerFor(adb);

    const result = await controller.dispatch({ key: "pause" });

    expect(result.state).toBe("paused");
    expect(adb.commands).toContain("shell media dispatch pause");
  });

  test("a rejected cmd that is not an unavailable command is an ActionableError", async () => {
    const adb = new ScriptedAdb()
      .dumps(PLAYING)
      .on("shell cmd media_session dispatch pause", new Error("adb: device offline"));
    const { controller } = controllerFor(adb);

    await expect(controller.dispatch({ key: "pause" })).rejects.toBeInstanceOf(ActionableError);
  });

  test("fails when neither media shell command exists", async () => {
    const unavailable = Object.assign(new Error("exit 20"), {
      stderr: "cmd: Can't find service: media_session",
    });
    const adb = new ScriptedAdb()
      .dumps(PLAYING)
      .on("shell cmd media_session dispatch pause", unavailable)
      .on(
        "shell media dispatch pause",
        ok("/system/bin/sh: media: inaccessible or not found\nUnknown command"),
      );
    const { controller } = controllerFor(adb);

    await expect(controller.dispatch({ key: "pause" })).rejects.toThrow(
      /neither 'cmd media_session'/,
    );
  });
});

describe("AndroidMediaSessionController.setVolume", () => {
  const get = "shell cmd media_session volume --stream 3 --get";
  const reading = (level: number) =>
    ok(
      `[v] will get volume\n[v] Connecting to AudioService\n[v] volume is ${level} in range [0..25]\n`,
    );

  test("sets the stream, verifies by read-back and returns a restore receipt", async () => {
    const adb = new ScriptedAdb()
      .on(get, reading(7), reading(12))
      .on(`shell sh -c ${shellQuote(volumeSetScript(3, 12))}`, ok());
    const { controller } = controllerFor(adb);

    const result = await controller.setVolume({ stream: "music", level: 12 });

    expect(result).toEqual({
      stream: "music",
      previousLevel: 7,
      level: 12,
      requestedLevel: 12,
      min: 0,
      max: 25,
      changed: true,
      verified: true,
      restore: { volume: { stream: "music", level: 7 } },
    });
  });

  test("skips the write when the stream is already at the level", async () => {
    const adb = new ScriptedAdb().on(get, reading(7));
    const { controller } = controllerFor(adb);

    const result = await controller.setVolume({ stream: "music", level: 7 });

    expect(result.changed).toBe(false);
    expect(result.verified).toBe(true);
    expect(adb.commands).toEqual([get, get]);
  });

  test("reports an unverified write", async () => {
    const adb = new ScriptedAdb()
      .on(get, reading(7), reading(9))
      .on(`shell sh -c ${shellQuote(volumeSetScript(3, 12))}`, ok());
    const { controller } = controllerFor(adb);

    const result = await controller.setVolume({ stream: "music", level: 12 });

    expect(result.verified).toBe(false);
    expect(result.level).toBe(9);
  });

  test.each(["Permission Denial: setStreamVolume", "adb: device offline"])(
    "preserves a wrapped setter failure without retrying: %s",
    async (stderr) => {
      const set = `shell sh -c ${shellQuote(volumeSetScript(3, 12))}`;
      const failure = wrappedAdbRejection({ args: [set], exitCode: 1, stdout: "", stderr });
      expect(failure.message).toContain("Unknown command");
      const adb = new ScriptedAdb()
        .on(get, reading(7), reading(12))
        .on(set, failure)
        .on("shell cmd media_session volume --stream 3 --set 12", ok());
      const { controller } = controllerFor(adb);

      await expect(controller.setVolume({ stream: "music", level: 12 })).rejects.toMatchObject({
        cause: failure,
      });
      expect(adb.commands).toEqual([get, set]);
    },
  );

  test.each(["stdout", "stderr"])(
    "falls back when a wrapped setter failure has Unknown command in its own %s",
    async (stream) => {
      const set = `shell sh -c ${shellQuote(volumeSetScript(3, 12))}`;
      const failure = wrappedAdbRejection({
        args: [set],
        exitCode: 1,
        stdout: stream === "stdout" ? "Unknown command: set-volume" : "",
        stderr: stream === "stderr" ? "Unknown command: set-volume" : "",
      });
      const legacy = "shell cmd media_session volume --stream 3 --set 12";
      const adb = new ScriptedAdb()
        .on(get, reading(7), reading(12))
        .on(set, failure)
        .on(legacy, ok());
      const { controller } = controllerFor(adb);

      const result = await controller.setVolume({ stream: "music", level: 12 });

      expect(result.verified).toBe(true);
      expect(adb.commands).toEqual([get, set, legacy, get]);
    },
  );

  test("preserves the standalone media setter when both cmd setters are unavailable", async () => {
    const captured = ok(
      readFileSync(
        new URL("../../fixtures/android-volume/api37-stream-3.stdout.txt", import.meta.url),
        "utf8",
      ),
    );
    // Synthetic capability response: no older-API capture is available.
    const unavailable = ok("No shell command implementation.");
    const adb = new ScriptedAdb()
      .on(get, captured)
      .on(`shell sh -c ${shellQuote(volumeSetScript(3, 5))}`, unavailable)
      .on("shell cmd media_session volume --stream 3 --set 5", unavailable)
      .on("shell media volume --stream 3 --set 5", ok());
    const { controller } = controllerFor(adb);

    const result = await controller.setVolume({ stream: "music", level: 5 });

    expect(adb.commands).toContain("shell media volume --stream 3 --set 5");
    expect(result.restore).toEqual({ volume: { stream: "music", level: 11 } });
  });

  test("refuses an out-of-range level without writing", async () => {
    const adb = new ScriptedAdb().on(get, reading(7));
    const { controller } = controllerFor(adb);

    await expect(controller.setVolume({ stream: "music", level: 40 })).rejects.toThrow(
      /outside the music stream's range \[0\.\.25\]/,
    );
    expect(adb.commands).toEqual([get]);
  });

  test("maps ring and alarm to their AudioManager streams", async () => {
    const adb = new ScriptedAdb()
      .on("shell cmd media_session volume --stream 2 --get", reading(3))
      .on("shell cmd media_session volume --stream 4 --get", reading(5));
    const { controller } = controllerFor(adb);

    await controller.setVolume({ stream: "ring", level: 3 });
    await controller.setVolume({ stream: "alarm", level: 5 });

    expect(adb.commands).toContain("shell cmd media_session volume --stream 2 --get");
    expect(adb.commands).toContain("shell cmd media_session volume --stream 4 --get");
  });

  test("unparseable volume output is an ActionableError", async () => {
    const { controller } = controllerFor(new ScriptedAdb().on(get, ok("usage: ...")));

    await expect(controller.setVolume({ stream: "music", level: 1 })).rejects.toThrow(
      /Could not read the volume/,
    );
  });
});
