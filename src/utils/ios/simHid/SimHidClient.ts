import { errorMessage } from "../../describeUnknownError";
import type { IdGenerator } from "../../IdGenerator";
import { logger } from "../../logger";
import type { Timer } from "../../SystemTimer";
import type { SimHidTransport } from "./SimHidProcessLauncher";
import {
  outcomeFromAck,
  parseSimHidAck,
  type SimHidCommand,
  type SimHidOutcome,
} from "./SimHidProtocol";

/**
 * One running helper. The helper runs one command at a time, so the client writes one at a time
 * too: a queued command's timeout starts when it is written, not while it waits its turn.
 */
export interface SimHidClient {
  send(command: SimHidCommand, timeoutMs: number): Promise<SimHidOutcome>;
  readonly closed: boolean;
  close(): void;
}

interface Queued {
  command: SimHidCommand;
  timeoutMs: number;
  resolve: (outcome: SimHidOutcome) => void;
}

interface InFlight {
  id: string;
  resolve: (outcome: SimHidOutcome) => void;
  timeout: NodeJS.Timeout;
}

export class TransportSimHidClient implements SimHidClient {
  private readonly queue: Queued[] = [];
  private inFlight: InFlight | undefined;
  private isClosed = false;

  constructor(
    private readonly transport: SimHidTransport,
    private readonly idGenerator: IdGenerator,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">,
  ) {
    transport.onLine((line) => this.handleLine(line));
    transport.onClose(() => {
      this.isClosed = true;
      // The helper may have sent part of the gesture before it died.
      this.settleAll("sim-hid-helper exited before replying");
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(command: SimHidCommand, timeoutMs: number): Promise<SimHidOutcome> {
    if (this.isClosed) {
      return Promise.resolve({ status: "unavailable", reason: "sim-hid-helper has exited" });
    }
    return new Promise<SimHidOutcome>((resolve) => {
      this.queue.push({ command, timeoutMs, resolve });
      this.writeNext();
    });
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.settleAll("sim-hid-helper closed before replying");
    this.transport.close();
  }

  private writeNext(): void {
    const next = this.inFlight ? undefined : this.queue.shift();
    if (next) {
      // A write failure settles `next` synchronously and comes back here for the one after it.
      this.write(next);
    }
  }

  private write({ command, timeoutMs, resolve }: Queued): void {
    const id = this.idGenerator.next();
    const timeout = this.timer.setTimeout(() => {
      this.finish(id, {
        status: "indeterminate",
        reason: `sim-hid-helper did not reply within ${timeoutMs} ms`,
      });
    }, timeoutMs);
    this.inFlight = { id, resolve, timeout };
    try {
      this.transport.send(JSON.stringify({ id, ...command }));
    } catch (error) {
      logger.warn(`sim-hid-helper ${command.cmd} could not be written: ${errorMessage(error)}`);
      this.finish(id, {
        status: "unavailable",
        reason: `sim-hid-helper write failed: ${errorMessage(error)}`,
      });
    }
  }

  /** Settles the in-flight command `id` and writes the next queued one. */
  private finish(id: string, outcome: SimHidOutcome): void {
    const entry = this.inFlight;
    if (!entry || entry.id !== id) {
      return;
    }
    this.inFlight = undefined;
    this.timer.clearTimeout(entry.timeout);
    entry.resolve(outcome);
    this.writeNext();
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // Non-protocol output must not break pending commands.
      logger.debug(`sim-hid-helper ignored a non-JSON line: ${errorMessage(error)}`);
      return;
    }
    const ack = parseSimHidAck(parsed);
    if (ack) {
      this.finish(ack.id, outcomeFromAck(ack));
    }
  }

  /** The written command may have run; queued ones were never written. */
  private settleAll(reason: string): void {
    const entry = this.inFlight;
    this.inFlight = undefined;
    if (entry) {
      this.timer.clearTimeout(entry.timeout);
      entry.resolve({ status: "indeterminate", reason });
    }
    for (const queued of this.queue.splice(0)) {
      queued.resolve({ status: "unavailable", reason: "sim-hid-helper has exited" });
    }
  }
}
