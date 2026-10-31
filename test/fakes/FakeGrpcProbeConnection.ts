import { EventEmitter } from "node:events";
import type { GrpcProbeConnection } from "../../src/utils/audio/emulatorGrpcReachability";

export class FakeGrpcProbeConnection extends EventEmitter implements GrpcProbeConnection {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}
