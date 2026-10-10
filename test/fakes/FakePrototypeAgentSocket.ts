import type {
  PrototypeAgentConnector,
  PrototypeAgentSocket,
} from "../../src/features/prototype/ios/prototypeAgentClient";

/** In-memory agent socket: records host frames and lets a test push agent frames or close. */
export class FakePrototypeAgentSocket implements PrototypeAgentSocket {
  readonly written: string[] = [];
  ended = false;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly closeListeners: Array<(error?: Error) => void> = [];

  write(data: string): void {
    this.written.push(data);
  }

  end(): void {
    this.ended = true;
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (error?: Error) => void): void {
    this.closeListeners.push(listener);
  }

  /** Frames the host wrote, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.written
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  pushRaw(chunk: string): void {
    this.dataListeners.forEach((listener) => listener(chunk));
  }

  push(message: Record<string, unknown>): void {
    this.pushRaw(`${JSON.stringify(message)}\n`);
  }

  closeFromAgent(error?: Error): void {
    this.closeListeners.forEach((listener) => listener(error));
  }
}

export class FakePrototypeAgentConnector implements PrototypeAgentConnector {
  readonly ports: number[] = [];
  connectError: Error | undefined;

  constructor(readonly socket: FakePrototypeAgentSocket = new FakePrototypeAgentSocket()) {}

  async connect(port: number): Promise<PrototypeAgentSocket> {
    this.ports.push(port);
    if (this.connectError !== undefined) {
      throw this.connectError;
    }
    return this.socket;
  }
}
