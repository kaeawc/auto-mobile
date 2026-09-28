import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnedProcess } from "../../src/features/webrtc/processSpawner";
import {
  VIDEO_SERVER_HANDSHAKE_VERSION,
  VIDEO_SERVER_SOCKET_PREFIX,
} from "../../src/features/webrtc/PersistentEncoderH264Source";

/** Child process stand-in for both video sources. */
export class FakeSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
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
