import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import type { SpawnedProcess } from "../../src/features/webrtc/processSpawner";
import type { AdbProcess } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  VIDEO_SERVER_HANDSHAKE_VERSION,
  VIDEO_SERVER_SOCKET_PREFIX,
} from "../../src/features/webrtc/PersistentEncoderH264Source";

/** Child process stand-in for both video sources, satisfying the ADB and host spawn surfaces. */
export class FakeSpawnedProcess extends EventEmitter implements SpawnedProcess, AdbProcess {
  readonly stdin: Writable | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Every signal passed to {@link kill}, in order. */
  killSignals: string[] = [];

  get killed(): boolean {
    return this.killSignals.length > 0;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }

  ready(
    token: string = "session-0001",
    socketName: string = `${VIDEO_SERVER_SOCKET_PREFIX}_session0001`,
    pid: number = 1234,
    proto: number | null = VIDEO_SERVER_HANDSHAKE_VERSION,
  ): void {
    const protoSuffix = proto === null ? "" : ` proto=${proto}`;
    this.stdout.write(
      Buffer.from(
        `VIDEO_SESSION_READY token=${token} pid=${pid} socket=${socketName}${protoSuffix}\n`,
      ),
    );
    this.stdout.write(
      Buffer.from(`Waiting for client connection on localabstract:${socketName}\n`),
    );
  }

  readyAndStreamingStarted(): void {
    this.stdout.write(
      Buffer.from(
        `VIDEO_SESSION_READY token=session-0001 pid=1234 socket=${VIDEO_SERVER_SOCKET_PREFIX}_session0001\n` +
          "Streaming started\n",
      ),
    );
  }

  streamingStarted(): void {
    this.stdout.write(Buffer.from("Streaming started\n"));
  }

  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.simulateExit(code, signal);
  }
}
