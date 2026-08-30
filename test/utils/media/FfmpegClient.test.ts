import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  DefaultFfmpegClient,
  resolveFfmpegBinary,
  type FfmpegProcess,
} from "../../../src/utils/media/FfmpegClient";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeFfmpegProcess extends EventEmitter implements FfmpegProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    return true;
  }

  exit(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close");
  }
}

describe("FfmpegClient", () => {
  test("resolves an explicit binary before configured environment variables and the default", () => {
    expect(
      resolveFfmpegBinary({
        explicitPath: "/tools/ffmpeg",
        env: { AUTOMOBILE_FFMPEG: "/env/ffmpeg" },
      }),
    ).toBe("/tools/ffmpeg");
    expect(
      resolveFfmpegBinary({
        env: { AUTOMOBILE_FFMPEG: "/env/ffmpeg" },
      }),
    ).toBe("/env/ffmpeg");
    expect(resolveFfmpegBinary({ env: {} })).toBe("ffmpeg");
  });

  test("starts through the injected process boundary with an argv array", () => {
    const process = new FakeFfmpegProcess();
    const calls: Array<{ binary: string; args: string[]; stdio: unknown }> = [];
    const client = new DefaultFfmpegClient({
      binaryPath: "/tools/ffmpeg",
      spawn: (binary, args, options) => {
        calls.push({ binary, args, stdio: options.stdio });
        return process;
      },
    });

    const started = client.start({
      args: ["-i", "/tmp/a file;still-safe.mov", "-y", "/tmp/output.mp4"],
      stdio: ["ignore", "pipe", "pipe"],
      context: "scale iOS recording",
    });

    expect(started.process).toBe(process);
    expect(calls).toEqual([
      {
        binary: "/tools/ffmpeg",
        args: ["-i", "/tmp/a file;still-safe.mov", "-y", "/tmp/output.mp4"],
        stdio: ["ignore", "pipe", "pipe"],
      },
    ]);
  });

  test("probes version and encoder capabilities with actionable failures", async () => {
    const processes = [new FakeFfmpegProcess(), new FakeFfmpegProcess()];
    const client = new DefaultFfmpegClient({
      spawn: () => {
        const process = processes.shift();
        if (!process) {
          throw new Error("unexpected spawn");
        }
        queueMicrotask(() => {
          process.stdout.write(
            processes.length === 1 ? "ffmpeg version 7.1\n" : " V..... h264_videotoolbox\n",
          );
          process.exit();
        });
        return process;
      },
    });

    await expect(client.probe({ requiredEncoders: ["h264_videotoolbox"] })).resolves.toEqual({
      version: "7.1",
      encoders: ["h264_videotoolbox"],
    });
  });

  test("shares one timeout budget across both prerequisite probe commands", async () => {
    const timer = new FakeTimer();
    const versionProcess = new FakeFfmpegProcess();
    const encodersProcess = new FakeFfmpegProcess();
    encodersProcess.kill = (signal?: NodeJS.Signals | number): boolean => {
      encodersProcess.killSignals.push(signal);
      encodersProcess.killed = true;
      queueMicrotask(() => encodersProcess.exit(0, signal as NodeJS.Signals));
      return true;
    };
    const processes = [versionProcess, encodersProcess];
    const client = new DefaultFfmpegClient({
      timer,
      spawn: () => {
        const process = processes.shift();
        if (!process) {
          throw new Error("unexpected spawn");
        }
        return process;
      },
    });

    const probing = client.probe({ timeoutMs: 100 });
    timer.setTimeout(() => {
      versionProcess.stdout.write("ffmpeg version 7.1\n");
      versionProcess.exit();
    }, 80);
    timer.advanceTime(80);
    for (let attempt = 0; attempt < 20 && processes.length > 0; attempt++) {
      await Promise.resolve();
    }

    expect(timer.getPendingTimeouts()).toContain(20);
    timer.advanceTime(20);
    await expect(probing).rejects.toThrow("FFmpeg encoder probe failed");
    expect(encodersProcess.killSignals).toEqual(["SIGKILL"]);
  });

  test("reports non-zero exits with the command context and stderr", async () => {
    const process = new FakeFfmpegProcess();
    const client = new DefaultFfmpegClient({
      spawn: () => {
        queueMicrotask(() => {
          process.stderr.write("unknown encoder");
          process.exit(1);
        });
        return process;
      },
    });

    await expect(client.run({ args: ["-encoders"], context: "encoder probe" })).rejects.toThrow(
      /encoder probe.*unknown encoder/s,
    );
  });

  test("tears down both sides when a streaming pipe fails", () => {
    const capture = new FakeFfmpegProcess();
    const encoder = new FakeFfmpegProcess();
    const client = new DefaultFfmpegClient();

    client.pipe({
      source: capture.stdout,
      destination: encoder.stdin,
      context: "Android screen recording",
      processes: [capture, encoder],
    });
    encoder.stdin.emit("error", new Error("EPIPE"));

    expect(capture.killSignals).toEqual(["SIGKILL"]);
    expect(encoder.killSignals).toEqual(["SIGKILL"]);
  });
});
