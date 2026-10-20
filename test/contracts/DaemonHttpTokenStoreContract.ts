import { describe, expect, test } from "bun:test";
import type { DaemonHttpTokenStore } from "../../src/daemon/daemonHttpToken";

export function runDaemonHttpTokenStoreContract(
  name: string,
  make: () => {
    store: DaemonHttpTokenStore;
    replaceToken: (token: string) => void;
    dispose: () => void;
  },
): void {
  describe(`DaemonHttpTokenStore contract: ${name}`, () => {
    test("reads absent, publishes, overwrites stale content, and removes idempotently", () => {
      const { store, dispose } = make();
      try {
        expect(store.read()).toBeUndefined();
        store.write("first-token");
        expect(store.read()).toBe("first-token");
        store.write("next-token");
        expect(store.read()).toBe("next-token");
        store.remove();
        expect(store.read()).toBeUndefined();
        store.remove();
        expect(store.read()).toBeUndefined();
      } finally {
        dispose();
      }
    });

    test("removes only its own publication and preserves replacement content", () => {
      const { store, replaceToken, dispose } = make();
      try {
        replaceToken("other-daemon");
        store.remove();
        expect(store.read()).toBe("other-daemon");
        store.write("own-token");
        replaceToken("successor");
        store.remove();
        expect(store.read()).toBe("successor");
      } finally {
        dispose();
      }
    });
  });
}
