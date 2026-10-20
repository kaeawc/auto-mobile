import { describe, expect, test } from "bun:test";
import type {
  ConfigRepository,
  KeyedConfigRepository,
} from "../../src/db/keyedJsonConfigRepository";

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
        expect<TConfig | null>(await repository.getConfig()).toEqual(samples.first);
        await repository.setConfig(samples.second);
        expect<TConfig | null>(await repository.getConfig()).toEqual(samples.second);
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
        expect<TConfig | null>(await repository.getConfig()).toEqual(samples.first);
        expect<TConfig | null>(await repository.getConfig("session-a")).toEqual(samples.second);
        expect(await repository.getConfig("session-b")).toBeNull();
        await repository.clearConfig("session-a");
        expect(await repository.getConfig("session-a")).toBeNull();
        expect<TConfig | null>(await repository.getConfig()).toEqual(samples.first);
      }));

    test("neither the stored nor the returned config aliases the caller's objects, at any depth", () =>
      withRepository(async (repository) => {
        const input = structuredClone(samples.second);
        await repository.setConfig(input);
        mutateDeep(input);
        expect<TConfig | null>(await repository.getConfig()).toEqual(samples.second);
        const read = await repository.getConfig();
        mutateDeep(read);
        expect<TConfig | null>(await repository.getConfig()).toEqual(samples.second);
      }));
  });
}

/** Flip every leaf and add a key at each object level, so any shared reference shows up. */
function mutateDeep(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === "object" && child !== null) {
      mutateDeep(child);
    } else if (typeof child === "number") {
      record[key] = child + 1;
    } else if (typeof child === "boolean") {
      record[key] = !child;
    }
  }
  record.__mutated = true;
}

/**
 * Extra contract for repositories whose rows can be enumerated by key prefix (the
 * per-session appearance rows, #10976). Run it in addition to {@link runConfigRepositoryContract}.
 */
export function runKeyedConfigRepositoryContract<TConfig>(
  name: string,
  make: () => Promise<{
    repository: KeyedConfigRepository<TConfig>;
    dispose?: () => Promise<void>;
  }>,
  sample: TConfig,
): void {
  describe(`KeyedConfigRepository contract: ${name}`, () => {
    test("listKeys returns only keys with the prefix and follows set and clear", async () => {
      const { repository, dispose } = await make();
      try {
        expect(await repository.listKeys("session:")).toEqual([]);
        await repository.setConfig(sample, "session:a");
        await repository.setConfig(sample, "session:b");
        await repository.setConfig(sample, "other");
        await repository.setConfig(sample);
        expect((await repository.listKeys("session:")).sort()).toEqual(["session:a", "session:b"]);
        await repository.clearConfig("session:a");
        expect(await repository.listKeys("session:")).toEqual(["session:b"]);
        expect(await repository.listKeys("nothing")).toEqual([]);
      } finally {
        await dispose?.();
      }
    });
  });
}
