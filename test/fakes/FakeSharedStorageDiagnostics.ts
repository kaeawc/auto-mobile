import type { SharedStorageDiagnostics } from "../../src/server/sharedStorageDiagnostics";

export class FakeSharedStorageDiagnostics implements SharedStorageDiagnostics {
  calls = 0;
  state = "echo ok: ok\nsys.boot_completed: 1\ndf /sdcard: 10G available";

  async collect(): Promise<string> {
    this.calls++;
    return this.state;
  }
}
