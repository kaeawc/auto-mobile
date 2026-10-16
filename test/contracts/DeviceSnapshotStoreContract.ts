import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { DeviceSnapshotStore, SnapshotPathOptions } from "../../src/utils/DeviceSnapshotStore";

type Store = Pick<
  DeviceSnapshotStore,
  | "getBasePath"
  | "getSnapshotPathWithOptions"
  | "snapshotDirectoryExists"
  | "getSnapshotSizeBytes"
  | "replaceSnapshotData"
  | "deleteSnapshotData"
  | "recoverSnapshotData"
  | "discardSnapshotArtifacts"
  | "generateSnapshotName"
>;

export interface DeviceSnapshotStoreHandle {
  store: Store;
  /** Make the capture callback leave `bytes` of snapshot data behind for `name` in `options`' scope. */
  materialize(name: string, options: SnapshotPathOptions | undefined, bytes: number): Promise<void>;
  dispose?: () => Promise<void>;
}

const ANDROID_A: SnapshotPathOptions = { platform: "android", avdName: "Pixel_A" };
const ANDROID_B: SnapshotPathOptions = { platform: "android", avdName: "Pixel_B" };

/**
 * Shared behavioural contract for {@link DeviceSnapshotStore} (#11868): the fake and the real
 * store (over a private temporary directory) must agree on snapshot paths, scoped existence,
 * atomic replace, delete, size and name generation.
 */
export function runDeviceSnapshotStoreContract(
  name: string,
  make: () => Promise<DeviceSnapshotStoreHandle>,
): void {
  const withStore = async (
    body: (handle: DeviceSnapshotStoreHandle) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`DeviceSnapshotStore contract: ${name}`, () => {
    test("scoped paths live under the base path and differ per scope", () =>
      withStore(async ({ store }) => {
        const base = store.getBasePath();
        const unscoped = store.getSnapshotPathWithOptions("snap");
        const a = store.getSnapshotPathWithOptions("snap", ANDROID_A);
        const b = store.getSnapshotPathWithOptions("snap", ANDROID_B);
        for (const candidate of [unscoped, a, b]) {
          expect(path.relative(base, candidate).startsWith("..")).toBe(false);
          expect(path.basename(candidate)).toBe("snap");
        }
        expect(new Set([unscoped, a, b]).size).toBe(3);
        expect(() =>
          store.getSnapshotPathWithOptions("snap", { platform: "ios", deviceId: "../escape" }),
        ).toThrow();
      }));

    test("an uncaptured snapshot does not exist and has size zero", () =>
      withStore(async ({ store }) => {
        expect(await store.snapshotDirectoryExists("nope")).toBe(false);
        expect(await store.getSnapshotSizeBytes("nope")).toBe(0);
      }));

    test("a successful replace makes the snapshot exist in exactly its own scope", () =>
      withStore(async ({ store, materialize }) => {
        await store.replaceSnapshotData("snap", ANDROID_A, () =>
          materialize("snap", ANDROID_A, 10),
        );
        expect(await store.snapshotDirectoryExists("snap", ANDROID_A)).toBe(true);
        expect(await store.snapshotDirectoryExists("snap", ANDROID_B)).toBe(false);
        expect(await store.getSnapshotSizeBytes("snap", ANDROID_A)).toBe(10);
      }));

    test("replace returns the capture result and a replacement supersedes the old data", () =>
      withStore(async ({ store, materialize }) => {
        await store.replaceSnapshotData("snap", undefined, () =>
          materialize("snap", undefined, 10),
        );
        const result = await store.replaceSnapshotData("snap", undefined, async () => {
          await materialize("snap", undefined, 3);
          return "captured";
        });
        expect(result).toBe("captured");
        expect(await store.getSnapshotSizeBytes("snap")).toBe(3);
      }));

    test("a failed first capture leaves nothing; a failed overwrite keeps the prior snapshot", () =>
      withStore(async ({ store, materialize }) => {
        await expect(
          store.replaceSnapshotData("fresh", undefined, async () => {
            throw new Error("capture failed");
          }),
        ).rejects.toThrow("capture failed");
        expect(await store.snapshotDirectoryExists("fresh")).toBe(false);

        await store.replaceSnapshotData("snap", undefined, () => materialize("snap", undefined, 7));
        await expect(
          store.replaceSnapshotData("snap", undefined, async () => {
            throw new Error("capture failed");
          }),
        ).rejects.toThrow("capture failed");
        expect(await store.snapshotDirectoryExists("snap")).toBe(true);
        expect(await store.getSnapshotSizeBytes("snap")).toBe(7);
      }));

    test("deleteSnapshotData removes only its scope and tolerates a missing snapshot", () =>
      withStore(async ({ store, materialize }) => {
        await store.replaceSnapshotData("snap", ANDROID_A, () => materialize("snap", ANDROID_A, 1));
        await store.replaceSnapshotData("snap", ANDROID_B, () => materialize("snap", ANDROID_B, 1));
        await store.deleteSnapshotData("snap", ANDROID_A);
        await store.deleteSnapshotData("never-existed", ANDROID_A);
        expect(await store.snapshotDirectoryExists("snap", ANDROID_A)).toBe(false);
        expect(await store.snapshotDirectoryExists("snap", ANDROID_B)).toBe(true);
      }));

    test("recovery and artifact discard on a clean store are no-ops", () =>
      withStore(async ({ store }) => {
        await store.recoverSnapshotData("snap", ANDROID_A);
        expect(await store.discardSnapshotArtifacts("snap", ANDROID_A)).toEqual([]);
        expect(await store.snapshotDirectoryExists("snap", ANDROID_A)).toBe(false);
      }));

    test("generated names are non-empty path-safe segments that carry the sanitized device name", () =>
      withStore(async ({ store }) => {
        const plain = store.generateSnapshotName();
        const named = store.generateSnapshotName("Pixel 6/Pro!");
        for (const generated of [plain, named]) {
          expect(generated.length).toBeGreaterThan(0);
          expect(generated).toMatch(/^[A-Za-z0-9_-]+$/);
        }
        expect(named.startsWith("Pixel_6_Pro_")).toBe(true);
      }));
  });
}
