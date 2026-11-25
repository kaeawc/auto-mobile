import type { EmulatorGrpcPortListenerProbe } from "../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorGrpcPortListenerProbe";

/** Ports in `listening` accept connections; tests add one when a fake emulator binds it. */
export class FakeEmulatorGrpcPortListenerProbe implements EmulatorGrpcPortListenerProbe {
  readonly probed: number[] = [];

  constructor(readonly listening = new Set<number>()) {}

  async isListening(port: number): Promise<boolean> {
    this.probed.push(port);
    return this.listening.has(port);
  }
}
