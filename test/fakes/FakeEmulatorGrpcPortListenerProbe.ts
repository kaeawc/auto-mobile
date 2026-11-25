import type { EmulatorGrpcPortListenerProbe } from "../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorGrpcPortListenerProbe";

/** Ports in `listening` accept connections; tests add one when a fake emulator binds it. */
export class FakeEmulatorGrpcPortListenerProbe implements EmulatorGrpcPortListenerProbe {
  readonly probed: number[] = [];

  /** Ports whose check fails with an unclassified error (listener state unknown). */
  readonly failing = new Set<number>();

  constructor(readonly listening = new Set<number>()) {}

  async isListening(port: number): Promise<boolean> {
    this.probed.push(port);
    if (this.failing.has(port)) {
      throw new Error(`gRPC port ${port} listener check failed: EACCES`);
    }
    return this.listening.has(port);
  }
}
