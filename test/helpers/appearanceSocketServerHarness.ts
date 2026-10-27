import type { Socket } from "net";
import { AppearanceSocketServer } from "../../src/daemon/appearanceSocketServer";

/** Drives one request line through the appearance server without opening a listener. */
export class AppearanceSocketServerHarness extends AppearanceSocketServer {
  /** Process a line and wait for the request chain on that socket to settle. */
  async handleLineAndSettle(socket: Socket, line: string): Promise<void> {
    await this.processLine(socket, line);
    await this.pendingBySocket.get(socket);
  }
}
