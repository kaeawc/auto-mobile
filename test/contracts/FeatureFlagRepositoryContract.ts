import { describe, expect, test } from "bun:test";
import type { FeatureFlagDefinition } from "../../src/features/featureFlags/FeatureFlagDefinitions";
import type { FeatureFlagRepository } from "../../src/features/featureFlags/FeatureFlagRepository";

const definition = (
  key: FeatureFlagDefinition["key"],
  defaultValue: boolean,
  defaultConfig?: Record<string, unknown>,
): FeatureFlagDefinition => ({
  key,
  label: key,
  description: key,
  defaultValue,
  ...(defaultConfig ? { defaultConfig } : {}),
});

export interface FeatureFlagRepositoryHandle {
  repository: FeatureFlagRepository;
  dispose?: () => Promise<void>;
}

/**
 * Shared behavioural contract for {@link FeatureFlagRepository} (#11868): run it against
 * the in-memory fake and the SQLite implementation over an in-memory database so the
 * fake cannot drift from what the real repository persists.
 */
export function runFeatureFlagRepositoryContract(
  name: string,
  make: () => Promise<FeatureFlagRepositoryHandle>,
): void {
  const withRepository = async (
    body: (repository: FeatureFlagRepository) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.repository);
    } finally {
      await handle.dispose?.();
    }
  };
  const byKey = async (repository: FeatureFlagRepository) =>
    new Map((await repository.listFlags()).map((record) => [record.key, record]));

  describe(`FeatureFlagRepository contract: ${name}`, () => {
    test("ensureFlags seeds defaults, including default config", () =>
      withRepository(async (repository) => {
        await repository.ensureFlags([
          definition("debug", false),
          definition("ui-perf-mode", true, { level: 2 }),
        ]);
        const flags = await byKey(repository);
        expect(flags.size).toBe(2);
        expect(flags.get("debug")).toMatchObject({ enabled: false, config: null });
        expect(flags.get("ui-perf-mode")).toMatchObject({ enabled: true, config: { level: 2 } });
        expect(typeof flags.get("debug")?.updatedAt).toBe("string");
      }));

    test("ensureFlags never overwrites an existing flag", () =>
      withRepository(async (repository) => {
        await repository.ensureFlags([definition("debug", false)]);
        await repository.upsertFlag("debug", true, { mode: "x" });
        await repository.ensureFlags([definition("debug", false, { other: 1 })]);
        expect((await byKey(repository)).get("debug")).toMatchObject({
          enabled: true,
          config: { mode: "x" },
        });
      }));

    test("ensureFlags with no definitions is a no-op", () =>
      withRepository(async (repository) => {
        await repository.ensureFlags([]);
        expect(await repository.listFlags()).toEqual([]);
      }));

    test("upsertFlag inserts a flag that was never seeded", () =>
      withRepository(async (repository) => {
        await repository.upsertFlag("debug-perf", true);
        expect((await byKey(repository)).get("debug-perf")).toMatchObject({
          enabled: true,
          config: null,
        });
      }));

    test("upsertFlag without a config keeps the stored config", () =>
      withRepository(async (repository) => {
        await repository.upsertFlag("debug", true, { keep: true });
        await repository.upsertFlag("debug", false);
        expect((await byKey(repository)).get("debug")).toMatchObject({
          enabled: false,
          config: { keep: true },
        });
      }));

    test("upsertFlag with an explicit null config clears the stored config", () =>
      withRepository(async (repository) => {
        await repository.upsertFlag("debug", true, { keep: true });
        await repository.upsertFlag("debug", true, null);
        expect((await byKey(repository)).get("debug")?.config).toBeNull();
      }));

    test("upsertFlag with a new config replaces the stored config", () =>
      withRepository(async (repository) => {
        await repository.upsertFlag("debug", true, { a: 1 });
        await repository.upsertFlag("debug", true, { b: 2 });
        expect((await byKey(repository)).get("debug")?.config).toEqual({ b: 2 });
      }));

    test("one record per key after repeated upserts", () =>
      withRepository(async (repository) => {
        await repository.upsertFlag("debug", true);
        await repository.upsertFlag("debug", false);
        await repository.upsertFlag("debug", true);
        expect(await repository.listFlags()).toHaveLength(1);
      }));
  });
}
