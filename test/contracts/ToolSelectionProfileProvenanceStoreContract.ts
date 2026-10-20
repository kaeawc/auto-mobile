import { describe, expect, test } from "bun:test";
import type { ToolSelectionProfileProvenanceStore } from "../../src/db/toolSelectionProfileProvenanceRepository";

export interface ToolSelectionProfileProvenanceStoreHandle {
  store: ToolSelectionProfileProvenanceStore;
  dispose?: () => Promise<void>;
}

/**
 * Shared behavioural contract for {@link ToolSelectionProfileProvenanceStore} (#11868): run it
 * against the in-memory fake and the SQLite repository over an in-memory database. The real
 * table is a set with no ordering guarantee, so membership is compared sorted.
 */
export function runToolSelectionProfileProvenanceStoreContract(
  name: string,
  make: () => Promise<ToolSelectionProfileProvenanceStoreHandle>,
): void {
  const withStore = async (
    body: (store: ToolSelectionProfileProvenanceStore) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.store);
    } finally {
      await handle.dispose?.();
    }
  };
  const loaded = async (store: ToolSelectionProfileProvenanceStore): Promise<string[]> =>
    [...(await store.loadAll())].sort();

  describe(`ToolSelectionProfileProvenanceStore contract: ${name}`, () => {
    test("an empty store loads no profiles", () =>
      withStore(async (store) => {
        expect(await store.loadAll()).toEqual([]);
      }));

    test("inserted profile uuids round-trip as a set", () =>
      withStore(async (store) => {
        await store.insert("profile-b");
        await store.insert("profile-a");
        await store.insert("profile-c");
        expect(await loaded(store)).toEqual(["profile-a", "profile-b", "profile-c"]);
      }));

    test("re-inserting the same uuid is an idempotent no-op", () =>
      withStore(async (store) => {
        await store.insert("profile-a");
        await store.insert("profile-a");
        await store.insert("profile-b");
        await store.insert("profile-a");
        expect(await loaded(store)).toEqual(["profile-a", "profile-b"]);
      }));

    test("uuids are matched exactly, never case-folded or trimmed", () =>
      withStore(async (store) => {
        await store.insert("Profile-A");
        await store.insert("profile-a");
        await store.insert("profile-a ");
        expect(await loaded(store)).toEqual(["Profile-A", "profile-a", "profile-a "]);
      }));

    test("a loaded array is a snapshot that later inserts do not mutate", () =>
      withStore(async (store) => {
        await store.insert("profile-a");
        const first = await store.loadAll();
        await store.insert("profile-b");
        expect(first).toEqual(["profile-a"]);
        expect(await loaded(store)).toEqual(["profile-a", "profile-b"]);
      }));
  });
}
