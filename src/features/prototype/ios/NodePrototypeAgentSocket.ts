import { type Socket } from "node:net";
import type { PrototypeAgentSocket } from "./prototypeAgentClient";

export class NodePrototypeAgentSocket implements PrototypeAgentSocket {
  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
  }

  write(data: string): void {
    this.socket.write(data);
  }

  end(): void {
    this.socket.end();
  }

  onData(listener: (chunk: string) => void): void {
    this.socket.on("data", (chunk: string) => listener(chunk));
  }

  onClose(listener: (error?: Error) => void): void {
    let lastError: Error | undefined;
    this.socket.on("error", (error) => {
      lastError = error;
    });
    this.socket.on("close", () => listener(lastError));
  }
}
