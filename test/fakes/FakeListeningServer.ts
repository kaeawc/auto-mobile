import { Server } from "node:net";

/**
 * A never-bound net.Server that reports `listening: true`. Socket-server tests
 * assign it to `BaseSocketServer.server` (a protected field) so isRunning() and
 * the start/stop hooks run without binding a real Unix socket.
 */
export class FakeListeningServer extends Server {
  override get listening(): boolean {
    return true;
  }
}
