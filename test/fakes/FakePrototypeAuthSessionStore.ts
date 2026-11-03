import type {
  PrototypeAuthSessionStore,
  PrototypeAuthStoredSession,
} from "../../src/features/prototype/prototypeAuthSession";

/** In-memory stand-in for the Keystore-backed store or the Keychain slot of one prototype. */
export class FakePrototypeAuthSessionStore implements PrototypeAuthSessionStore {
  session: PrototypeAuthStoredSession | undefined;
  writeError: Error | undefined;
  clearCount = 0;

  read(): PrototypeAuthStoredSession | undefined {
    return this.session;
  }

  write(session: PrototypeAuthStoredSession): void {
    if (this.writeError) {
      throw this.writeError;
    }
    this.session = { ...session };
  }

  clear(): void {
    this.clearCount++;
    this.session = undefined;
  }
}
