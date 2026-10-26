import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

/** Inert process handle with synchronous streaming and no OS process. */
export class StreamingChildProcess extends ChildProcess {
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}
