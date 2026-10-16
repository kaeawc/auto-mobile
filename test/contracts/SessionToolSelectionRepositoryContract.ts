import { describe, expect, test } from "bun:test";
import type { SessionToolSelectionRepository } from "../../src/features/toolSelection/SessionToolSelectionService";

export interface SessionToolSelectionRepositoryHandle {
  repository: SessionToolSelectionRepository;
  dispose?: () => Promise<void>;
}

/**
 * Shared behavioural contract for {@link SessionToolSelectionRepository} (#11868): run it
 * against the in-memory fake and the SQLite implementation over an in-memory database.
 */
export function runSessionToolSelectionRepositoryContract(
  name: string,
  make: () => Promise<SessionToolSelectionRepositoryHandle>,
): void {
  const withRepository = async (
    body: (repository: SessionToolSelectionRepository) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.repository);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`SessionToolSelectionRepository contract: ${name}`, () => {
    test("an unknown session lists nothing", () =>
      withRepository(async (repository) => {
        expect(await repository.list("missing")).toEqual(new Map());
      }));

    test("set stores both enabled and disabled overrides", () =>
      withRepository(async (repository) => {
        await repository.set("s1", "observe", false);
        await repository.set("s1", "sendKeys", true);
        expect(await repository.list("s1")).toEqual(
          new Map([
            ["observe", false],
            ["sendKeys", true],
          ]),
        );
      }));

    test("set on an existing tool overwrites it", () =>
      withRepository(async (repository) => {
        await repository.set("s1", "observe", false);
        await repository.set("s1", "observe", true);
        expect(await repository.list("s1")).toEqual(new Map([["observe", true]]));
      }));

    test("sessions are isolated from each other", () =>
      withRepository(async (repository) => {
        await repository.set("s1", "observe", false);
        await repository.set("s2", "observe", true);
        expect(await repository.list("s1")).toEqual(new Map([["observe", false]]));
        expect(await repository.list("s2")).toEqual(new Map([["observe", true]]));
      }));

    test("list returns a copy that does not alias stored state", () =>
      withRepository(async (repository) => {
        await repository.set("s1", "observe", false);
        (await repository.list("s1")).set("observe", true);
        expect(await repository.list("s1")).toEqual(new Map([["observe", false]]));
      }));

    test("setMany applies every entry and overwrites existing ones", () =>
      withRepository(async (repository) => {
        // Both shipped repositories offer the atomic batch; do not let it vanish silently.
        if (!repository.setMany) {
          throw new Error("repository must implement setMany");
        }
        await repository.set("s1", "observe", false);
        await repository.setMany("s1", [
          { toolName: "observe", enabled: true },
          { toolName: "clipboard", enabled: false },
        ]);
        expect(await repository.list("s1")).toEqual(
          new Map([
            ["observe", true],
            ["clipboard", false],
          ]),
        );
      }));

    test("setMany with no entries changes nothing", () =>
      withRepository(async (repository) => {
        // Both shipped repositories offer the atomic batch; do not let it vanish silently.
        if (!repository.setMany) {
          throw new Error("repository must implement setMany");
        }
        await repository.set("s1", "observe", true);
        await repository.setMany("s1", []);
        expect(await repository.list("s1")).toEqual(new Map([["observe", true]]));
      }));

    test("deleteSession removes only that session and tolerates a missing one", () =>
      withRepository(async (repository) => {
        await repository.set("s1", "observe", true);
        await repository.set("s2", "observe", false);
        await repository.deleteSession("s1");
        await repository.deleteSession("never-existed");
        expect(await repository.list("s1")).toEqual(new Map());
        expect(await repository.list("s2")).toEqual(new Map([["observe", false]]));
      }));
  });
}
