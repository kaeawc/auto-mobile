import type { AXBridgeTransport } from "../../src/utils/ios/AXBridgeClient";

export class FakeAXBridgeTransport implements AXBridgeTransport {
  readonly sent: string[] = [];
  closeCalls = 0;
  private lineListener: (line: string) => void = () => {};
  private closeListener: () => void = () => {};

  send(line: string): void {
    this.sent.push(line);
  }
  onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  close(): void {
    this.closeCalls++;
  }

  emitLine(line: string): void {
    this.lineListener(line);
  }
  emitExit(): void {
    this.closeListener();
  }
}
