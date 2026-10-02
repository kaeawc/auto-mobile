import type { IdentityRecoveryIO } from "../../src/daemon/identityRecovery";
import type { DaemonStatus } from "../../src/daemon/types";

/** No live namespace owner, without reading host PID files or probing sockets. */
export class FakeAbsentDaemonIdentity implements IdentityRecoveryIO {
  socketExists(): boolean {
    return false;
  }

  readRecord(): null {
    return null;
  }

  async probe(): Promise<DaemonStatus> {
    return { running: false };
  }
}
