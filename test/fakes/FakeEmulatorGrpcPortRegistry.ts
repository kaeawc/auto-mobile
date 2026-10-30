import type { EmulatorGrpcPortLease } from "../../src/utils/android-cmdline-tools/EmulatorPortReservations";
import type { EmulatorGrpcPortRegistry } from "../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorGrpcPortRegistry";

/** Separate registry views can share one store without sharing reservation module state. */
export class FakeEmulatorGrpcPortRegistry implements EmulatorGrpcPortRegistry {
  readonly claims: number[] = [];
  readonly failures = new Map<number, Error>();

  constructor(private readonly store = new Map<number, object>()) {}

  view(): FakeEmulatorGrpcPortRegistry {
    return new FakeEmulatorGrpcPortRegistry(this.store);
  }

  claim(port: number): EmulatorGrpcPortLease | undefined {
    this.claims.push(port);
    const error = this.failures.get(port);
    if (error) {
      throw error;
    }
    if (this.store.has(port)) {
      return undefined;
    }
    const owner = {};
    this.store.set(port, owner);
    return {
      port,
      release: () => {
        if (this.store.get(port) === owner) {
          this.store.delete(port);
        }
      },
    };
  }
}
