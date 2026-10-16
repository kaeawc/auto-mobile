import { describe, expect, test } from "bun:test";
import type { ConfigRepository } from "../../src/db/keyedJsonConfigRepository";

export interface ConfigRepositoryHandle<TConfig> {
  repository: ConfigRepository<TConfig>;
  dispose?: () => Promise<void>;
}

/**
 * Shared behavioural contract for {@link ConfigRepository} (#11868): run it against the
 * in-memory fakes and the keyed-JSON SQLite implementation over an in-memory database.
 * `first` and `second` must be distinct, schema-valid configs.
 */
export function runConfigRepositoryContract<TConfig>(
  name: string,
  make: () => Promise<ConfigRepositoryHandle<TConfig>>,
  samples: { first: TConfig; second: TConfig },
): void {
  const withRepository = async (
    body: (repository: ConfigRepository<TConfig>) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.repository);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`ConfigRepository contract: ${name}`, () => {
    test("an empty repository has no config", () =>
      withRepository(async (repository) => {
        expect(await repository.getConfig()).toBeNull();
      }));

    test("setConfig round-trips and a second set replaces it", () =>
      withRepository(async (repository) => {
        await repository.setConfig(samples.first);
        expect(await repository.getConfig()).toEqual(samples.first);
        await repository.setConfig(samples.second);
        expect(await repository.getConfig()).toEqual(samples.second);
      }));

    test("clearConfig removes the config and tolerates an empty repository", () =>
      withRepository(async (repository) => {
        await repository.clearConfig();
        await repository.setConfig(samples.first);
        await repository.clearConfig();
        expect(await repository.getConfig()).toBeNull();
      }));

    test("keyed rows are isolated from the global row and from each other", () =>
      withRepository(async (repository) => {
        await repository.setConfig(samples.first);
        await repository.setConfig(samples.second, "session-a");
        expect(await repository.getConfig()).toEqual(samples.first);
        expect(await repository.getConfig("session-a")).toEqual(samples.second);
        expect(await repository.getConfig("session-b")).toBeNull();
        await repository.clearConfig("session-a");
        expect(await repository.getConfig("session-a")).toBeNull();
        expect(await repository.getConfig()).toEqual(samples.first);
      }));

    test("the returned config does not alias stored state", () =>
      withRepository(async (repository) => {
        await repository.setConfig(samples.first);
        const read = await repository.getConfig();
        (read as Record<string, unknown>).__mutated = true;
        expect(await repository.getConfig()).toEqual(samples.first);
      }));
  });
}
