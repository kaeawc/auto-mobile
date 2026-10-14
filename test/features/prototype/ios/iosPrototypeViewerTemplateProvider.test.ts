import { beforeAll, describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  PrototypeViewerTemplateProvider,
  IOS_PROTOTYPE_VIEWER_ENV,
  SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD_ENV,
  PROTOTYPE_VIEWER_METADATA_FILENAME,
  type PrototypeViewerTemplateProviderDeps,
} from "../../../../src/features/prototype/ios/iosPrototypeViewerTemplateProvider";
import { PROTOTYPE_VIEWER_ARCHIVE_FILENAME } from "../../../../src/constants/release";
import * as errors from "../../../../src/features/prototype/ios/iosPrototypeInstallerErrors";
import { FakeFileDownloader } from "../../../fakes/FakeFileDownloader";
import { FakeChecksumCalculator } from "../../../fakes/FakeChecksumCalculator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { useScratchRoot } from "../../../helpers/scratchRoot";
import { IosPrototypeInstaller } from "../../../../src/features/prototype/ios/iosPrototypeInstaller";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import {
  FakeInstallerFileSystem,
  FakePrototypePlist,
  FakePrototypeIconRenderer,
  FakePrototypeSimctl,
  FakePrototypeDataWriter,
} from "../../../fakes/FakePrototypeInstaller";

const pin = "a".repeat(64);
const url = "https://example.invalid/AutoMobilePrototypeViewer.zip";
let payload: Buffer;
function zipPayload(names: string[]): Buffer {
  const zip = new AdmZip();
  for (const [i, name] of names.entries()) {
    zip.addFile(`entry-${i}`, Buffer.from("fixture"));
    zip.getEntry(`entry-${i}`)!.entryName = name;
  }
  return zip.toBuffer();
}

describe("PrototypeViewerTemplateProvider", () => {
  const scratch = useScratchRoot("prototype-viewer-unit-");
  beforeAll(() => {
    payload = zipPayload(["PrototypeViewer.app/Info.plist", "PrototypeViewer.app/PrototypeViewer"]);
    // Warm adm-zip's inflate path outside the per-test budget.
    new AdmZip(payload).getEntries().map((entry) => entry.getData());
  });
  function harness(overrides: PrototypeViewerTemplateProviderDeps = {}) {
    const cacheDir = scratch.next();
    const downloader = new FakeFileDownloader();
    downloader.payload = payload;
    const checksumCalculator = new FakeChecksumCalculator();
    checksumCalculator.checksum = pin;
    const timer = new FakeTimer();
    const deps = {
      cacheDir,
      downloader,
      checksumCalculator,
      timer,
      idGenerator: new FakeIdGenerator(),
      expectedChecksum: pin,
      releaseUrl: url,
      env: { AUTOMOBILE_VERSION: "0.0.84" },
      ...overrides,
    };
    const pinDir = path.join(cacheDir, deps.expectedChecksum.toLowerCase());
    mkdirSync(pinDir, { recursive: true });
    const app = path.join(pinDir, "PrototypeViewer.app");
    const archive = path.join(pinDir, PROTOTYPE_VIEWER_ARCHIVE_FILENAME);
    const metadata = path.join(pinDir, PROTOTYPE_VIEWER_METADATA_FILENAME);
    function makeApp(name?: string) {
      const dir = name === undefined ? app : path.join(cacheDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "Info.plist"), "plist");
      return dir;
    }
    function seedCache(sha256 = pin, size = payload.length) {
      makeApp();
      writeFileSync(archive, payload);
      writeFileSync(metadata, JSON.stringify({ version: "old", sha256, size, downloadedAt: 0 }));
    }
    return {
      cacheDir,
      pinDir,
      downloader,
      checksumCalculator,
      timer,
      deps,
      app,
      archive,
      metadata,
      makeApp,
      seedCache,
      provider: () => new PrototypeViewerTemplateProvider(deps),
    };
  }

  test("explicit override wins over env, local builds and release", async () => {
    const h = harness();
    const explicit = h.makeApp("explicit.app");
    h.deps.explicitPath = explicit;
    h.deps.env = { [IOS_PROTOTYPE_VIEWER_ENV]: "/missing" };
    h.deps.localBuildPaths = [h.makeApp("local.app")];
    expect(await h.provider().resolveDetailed()).toEqual({ path: explicit, source: "explicit" });
    expect(await h.provider().resolve()).toBe(explicit);
    expect(h.downloader.downloadedUrls).toEqual([]);
  });

  test("env override is anchored at the daemon launch directory", async () => {
    const h = harness();
    const app = h.makeApp("env.app");
    h.deps.env = {
      AUTOMOBILE_DAEMON_LAUNCH_CWD: h.cacheDir,
      [IOS_PROTOTYPE_VIEWER_ENV]: "env.app",
    };
    expect(await h.provider().resolveDetailed()).toEqual({ path: app, source: "env" });
    expect(h.downloader.downloadedUrls).toEqual([]);
  });

  test.each(["explicit", "env", "missing-plist", "file"])(
    "invalid override %s refuses fallback",
    async (kind) => {
      const h = harness();
      const candidate = path.join(h.cacheDir, "invalid.app");
      if (kind === "missing-plist") {
        mkdirSync(candidate);
      }
      if (kind === "file") {
        writeFileSync(candidate, "file");
      }
      if (kind === "explicit") {
        h.deps.explicitPath = candidate;
      } else {
        h.deps.env = { [IOS_PROTOTYPE_VIEWER_ENV]: candidate };
      }
      await expect(h.provider().resolve()).rejects.toBeInstanceOf(
        errors.PrototypeViewerOverrideError,
      );
      expect(h.downloader.downloadedUrls).toEqual([]);
    },
  );

  test("first usable local build wins and resolves relative paths", async () => {
    const h = harness();
    const app = h.makeApp("local.app");
    h.deps.env = { AUTOMOBILE_DAEMON_LAUNCH_CWD: h.cacheDir };
    h.deps.localBuildPaths = ["missing.app", "local.app", h.makeApp("other.app")];
    expect(await h.provider().resolveDetailed()).toEqual({ path: app, source: "local-build" });
    expect(h.downloader.downloadedUrls).toEqual([]);
  });

  test("no pin names version and the local build remedy, never downloads", async () => {
    const h = harness({ expectedChecksum: "", env: { AUTOMOBILE_VERSION: "0.0.1" } });
    const error = await h
      .provider()
      .resolve()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(errors.PrototypeViewerUnsupportedVersionError);
    if (!(error instanceof errors.PrototypeViewerUnsupportedVersionError)) {
      throw new Error("wrong error");
    }
    expect(error.version).toBe("0.0.1");
    expect(error.message).toContain("0.0.1");
    expect(error.message).toContain("prototype-viewer-build.sh");
    expect(error.message).toContain(IOS_PROTOTYPE_VIEWER_ENV);
    expect(h.downloader.downloadedUrls).toEqual([]);
  });

  test("cache hit rehashes the archive case-insensitively with zero downloads", async () => {
    const h = harness({ expectedChecksum: pin.toUpperCase() });
    h.seedCache(pin.toUpperCase());
    expect(await h.provider().resolveDetailed()).toEqual({ path: h.app, source: "cache" });
    expect(h.checksumCalculator.computedFiles).toEqual([h.archive]);
    expect(h.downloader.downloadedUrls).toEqual([]);
  });

  test.each([
    "wrong-pin",
    "rehash",
    "missing-plist",
    "wrong-size",
    "missing-archive",
    "bad-metadata",
  ])("cache %s is repaired by download", async (kind) => {
    const h = harness();
    h.seedCache(
      kind === "wrong-pin" ? "b".repeat(64) : pin,
      kind === "wrong-size" ? 1 : payload.length,
    );
    if (kind === "rehash") {
      h.checksumCalculator.setFileChecksum(h.archive, "b".repeat(64));
    }
    if (kind === "missing-plist") {
      await fs.rm(path.join(h.app, "Info.plist"));
    }
    if (kind === "missing-archive") {
      await fs.rm(h.archive);
    }
    if (kind === "bad-metadata") {
      writeFileSync(h.metadata, "not json");
    }
    expect((await h.provider().resolveDetailed()).source).toBe("download");
    expect(h.downloader.downloadedUrls).toEqual([url]);
  });

  test.each(["1", "TRUE"])("skip %s requires a verified cache", async (value) => {
    const h = harness({ env: { [SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD_ENV]: value } });
    await expect(h.provider().resolve()).rejects.toBeInstanceOf(
      errors.PrototypeViewerDownloadDisabledError,
    );
    h.seedCache();
    expect((await h.provider().resolveDetailed()).source).toBe("cache");
    expect(h.downloader.downloadedUrls).toEqual([]);
  });

  test("download verifies before extraction, publishes app/archive before sidecar, sets modes and reuses cache", async () => {
    const h = harness();
    const published: string[] = [];
    h.deps.renameFile = async (from, to) => {
      expect(existsSync(h.metadata)).toBe(false);
      expect(h.checksumCalculator.computedFiles).toEqual([`${h.archive}.fake-1.download`]);
      if (to === h.app) {
        expect(readFileSync(path.join(from, "Info.plist"), "utf8")).toBe("fixture");
      }
      published.push(to);
      await fs.rename(from, to);
    };
    const provider = h.provider();
    expect(await provider.resolveDetailed()).toEqual({ path: h.app, source: "download" });
    expect(published).toEqual([h.app, h.archive]);
    expect(JSON.parse(readFileSync(h.metadata, "utf8"))).toEqual({
      version: "0.0.84",
      sha256: pin,
      size: payload.length,
      downloadedAt: 0,
    });
    if (process.platform !== "win32") {
      expect(statSync(path.join(h.app, "PrototypeViewer")).mode & 0o777).toBe(0o755);
      expect(statSync(h.archive).mode & 0o777).toBe(0o600);
      expect(statSync(h.metadata).mode & 0o777).toBe(0o600);
    }
    expect((await provider.resolveDetailed()).source).toBe("cache");
    expect(h.downloader.downloadedUrls).toHaveLength(1);
    expect(readdirSync(h.pinDir).sort()).toEqual(
      [
        PROTOTYPE_VIEWER_METADATA_FILENAME,
        PROTOTYPE_VIEWER_ARCHIVE_FILENAME,
        "PrototypeViewer.app",
      ].sort(),
    );
  });

  test("checksum mismatch wins over invalid zip and removes only its own partial", async () => {
    const h = harness();
    h.downloader.payload = Buffer.from("not a zip");
    h.checksumCalculator.checksum = "b".repeat(64);
    const other = `${h.archive}.other.download`;
    writeFileSync(other, "other attempt");
    const error = await h
      .provider()
      .resolve()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(errors.PrototypeViewerChecksumMismatchError);
    if (!(error instanceof errors.PrototypeViewerChecksumMismatchError)) {
      throw new Error("wrong error");
    }
    expect(error.expected).toBe(pin);
    expect(error.actual).toBe("b".repeat(64));
    expect(error.message).toContain(pin);
    expect(error.message).toContain(error.actual);
    expect(readdirSync(h.pinDir)).toEqual([path.basename(other)]);
  });

  test.each([
    "invalid",
    "../evil",
    "/absolute-evil",
    "two-roots",
    "wrong-name",
    "missing-plist",
    "missing-executable",
    "__MACOSX/PrototypeViewer.app/._Info.plist",
    "PrototypeViewer.app/__MACOSX/file",
    "PrototypeViewer.app/._Info.plist",
    "PrototypeViewer.app/nested/._x",
  ])("refuses archive %s before publication", async (kind) => {
    const h = harness();
    const normal = ["PrototypeViewer.app/Info.plist", "PrototypeViewer.app/PrototypeViewer"];
    h.downloader.payload =
      kind === "invalid"
        ? Buffer.from("not a zip")
        : zipPayload(
            kind === "two-roots"
              ? [...normal, "Other.app/file"]
              : kind === "wrong-name"
                ? ["Other.app/Info.plist"]
                : kind === "missing-plist"
                  ? [normal[1]]
                  : kind === "missing-executable"
                    ? [normal[0]]
                    : [...normal, kind],
          );
    await expect(h.provider().resolve()).rejects.toBeInstanceOf(errors.PrototypeViewerExtractError);
    expect(readdirSync(h.pinDir)).toEqual([]);
    expect(existsSync(path.join(path.dirname(h.cacheDir), "evil"))).toBe(false);
  });

  test("network failure is typed with URL and cause; retry clears single-flight", async () => {
    const h = harness();
    const cause = new Error("network down");
    h.downloader.shouldThrow = cause;
    const provider = h.provider();
    const error = await provider.resolve().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(errors.PrototypeViewerDownloadError);
    if (!(error instanceof errors.PrototypeViewerDownloadError)) {
      throw new Error("wrong error");
    }
    expect(error.cause).toBe(cause);
    expect(error.message).toContain(url);
    expect(readdirSync(h.pinDir)).toEqual([]);
    h.downloader.shouldThrow = null;
    expect((await provider.resolveDetailed()).source).toBe("download");
  });

  test("timer abort throws DownloadError and cleans partial bytes", async () => {
    const h = harness({ downloadTimeoutMs: 10 });
    const entered = Promise.withResolvers<void>();
    h.downloader.download = async (_url, destination, signal) => {
      writeFileSync(destination, "partial");
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const pending = h.provider().resolve();
    await entered.promise;
    h.timer.advanceTime(10);
    await expect(pending).rejects.toBeInstanceOf(errors.PrototypeViewerDownloadError);
    await expect(pending).rejects.toThrow("Timed out");
    expect(readdirSync(h.pinDir)).toEqual([]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("single-flight shares one download between concurrent resolutions", async () => {
    const h = harness();
    const provider = h.provider();
    expect(await Promise.all([provider.resolve(), provider.resolve()])).toEqual([h.app, h.app]);
    expect(h.downloader.downloadedUrls).toHaveLength(1);
  });

  test("pin-A remains untouched while pin-B publishes without a sidecar", async () => {
    const h = harness();
    const oldPayload = Buffer.from("old-archive-A");
    h.seedCache(pin, oldPayload.length);
    writeFileSync(h.archive, oldPayload);
    writeFileSync(path.join(h.app, "Info.plist"), "OLD-A");
    const oldMetadata = readFileSync(h.metadata);
    const oldArchive = readFileSync(h.archive);
    const nextPin = "b".repeat(64);
    const nextDir = path.join(h.cacheDir, nextPin);
    const nextApp = path.join(nextDir, "PrototypeViewer.app");
    const nextMetadata = path.join(nextDir, PROTOTYPE_VIEWER_METADATA_FILENAME);
    const nextChecksum = new FakeChecksumCalculator();
    nextChecksum.checksum = nextPin;
    let observed = false;
    const nextProvider = new PrototypeViewerTemplateProvider({
      ...h.deps,
      expectedChecksum: nextPin.toUpperCase(),
      checksumCalculator: nextChecksum,
      renameFile: async (from, to) => {
        expect(path.dirname(from)).toStartWith(nextDir);
        expect(existsSync(nextMetadata)).toBe(false);
        await fs.rename(from, to);
        if (to === nextApp) {
          observed = true;
          expect(existsSync(nextMetadata)).toBe(false);
          expect(readFileSync(path.join(to, "Info.plist"), "utf8")).toBe("fixture");
          const old = await h.provider().resolveDetailed();
          expect(old).toEqual({ path: h.app, source: "cache" });
          expect(readFileSync(path.join(old.path, "Info.plist"), "utf8")).toBe("OLD-A");
        }
      },
    });
    expect(await nextProvider.resolve()).toBe(nextApp);
    expect(observed).toBe(true);
    expect(readFileSync(h.metadata)).toEqual(oldMetadata);
    expect(readFileSync(h.archive)).toEqual(oldArchive);
    expect(readFileSync(path.join(h.app, "Info.plist"), "utf8")).toBe("OLD-A");
    expect(readdirSync(h.cacheDir).sort()).toEqual([pin, nextPin]);
    expect(h.downloader.downloadedUrls).toEqual([url]);
  });

  test.each(["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY"])(
    "overlapping same-pin publisher reuses a verified winner on %s",
    async (code) => {
      const h = harness();
      const published: string[] = [];
      const winnerMetadata = JSON.stringify({
        sha256: pin,
        size: payload.length,
        downloadedAt: 42,
      });
      h.deps.renameFile = async (_from, to) => {
        published.push(to);
        expect(to).toBe(h.app);
        expect(existsSync(h.metadata)).toBe(false);
        // Another provider publishes between this attempt's cache miss and app rename.
        h.seedCache();
        writeFileSync(path.join(h.app, "Info.plist"), "winner");
        writeFileSync(h.metadata, winnerMetadata);
        throw Object.assign(new Error("concurrent app publication"), { code });
      };
      expect(await h.provider().resolve()).toBe(h.app);
      expect(published).toEqual([h.app]);
      expect(readFileSync(path.join(h.app, "Info.plist"), "utf8")).toBe("winner");
      expect(readFileSync(h.metadata, "utf8")).toBe(winnerMetadata);
      expect(readFileSync(h.archive)).toEqual(payload);
      expect(readdirSync(h.pinDir).sort()).toEqual(
        [
          PROTOTYPE_VIEWER_METADATA_FILENAME,
          PROTOTYPE_VIEWER_ARCHIVE_FILENAME,
          "PrototypeViewer.app",
        ].sort(),
      );
    },
  );

  test("winner completed during download is reused before invalidating its sidecar", async () => {
    const h = harness();
    h.downloader.download = async (_url, destination) => {
      writeFileSync(destination, payload);
      h.seedCache();
      writeFileSync(path.join(h.app, "Info.plist"), "winner");
    };
    h.deps.renameFile = async () => {
      throw new Error("a verified winner must not be replaced");
    };
    expect(await h.provider().resolve()).toBe(h.app);
    expect(readFileSync(path.join(h.app, "Info.plist"), "utf8")).toBe("winner");
    expect(JSON.parse(readFileSync(h.metadata, "utf8")).version).toBe("old");
    expect(readdirSync(h.pinDir).sort()).toEqual(
      [
        PROTOTYPE_VIEWER_METADATA_FILENAME,
        PROTOTYPE_VIEWER_ARCHIVE_FILENAME,
        "PrototypeViewer.app",
      ].sort(),
    );
  });

  test("unusable app is removed only after a rename conflict; sidecar is invalidated first", async () => {
    const h = harness();
    h.seedCache(pin, 1);
    writeFileSync(path.join(h.app, "stale"), "old");
    let appRenames = 0;
    h.deps.renameFile = async (from, to) => {
      expect(existsSync(h.metadata)).toBe(false);
      if (to === h.app) {
        appRenames++;
        expect(existsSync(to)).toBe(appRenames === 1);
        expect(existsSync(path.join(from, "Info.plist"))).toBe(true);
        if (appRenames === 1) {
          throw Object.assign(new Error("stale directory"), { code: "ENOTEMPTY" });
        }
      }
      await fs.rename(from, to);
    };
    expect(await h.provider().resolve()).toBe(h.app);
    expect(appRenames).toBe(2);
    expect(existsSync(path.join(h.app, "stale"))).toBe(false);
    expect(JSON.parse(readFileSync(h.metadata, "utf8")).sha256).toBe(pin);
  });

  test("failed stale-app rename retry preserves artifacts this attempt did not publish", async () => {
    const h = harness();
    h.seedCache(pin, 1);
    let appRenames = 0;
    h.deps.renameFile = async () => {
      appRenames++;
      if (appRenames === 2) {
        h.makeApp();
        writeFileSync(path.join(h.app, "other"), "other attempt");
      }
      throw Object.assign(new Error("busy directory"), { code: "EBUSY" });
    };
    await expect(h.provider().resolve()).rejects.toBeInstanceOf(
      errors.PrototypeViewerDownloadError,
    );
    expect(appRenames).toBe(2);
    expect(readFileSync(path.join(h.app, "other"), "utf8")).toBe("other attempt");
    expect(readFileSync(h.archive)).toEqual(payload);
    expect(existsSync(h.metadata)).toBe(false);
    expect(readdirSync(h.pinDir).sort()).toEqual(
      [PROTOTYPE_VIEWER_ARCHIVE_FILENAME, "PrototypeViewer.app"].sort(),
    );
  });

  test.each(["app", "archive", "sidecar"])(
    "publication failure at %s cleans everything this attempt published",
    async (phase) => {
      const h = harness();
      h.deps.renameFile = async (from, to) => {
        if ((phase === "app" && to === h.app) || (phase === "archive" && to === h.archive)) {
          throw new Error("rename denied");
        }
        await fs.rename(from, to);
        if (phase === "sidecar" && to === h.archive) {
          mkdirSync(h.metadata);
        }
      };
      await expect(h.provider().resolve()).rejects.toBeInstanceOf(
        errors.PrototypeViewerDownloadError,
      );
      expect(readdirSync(h.pinDir)).toEqual([]);
    },
  );

  test("installer preserves typed template cause and exposes its actionable remedy", async () => {
    const h = harness({ expectedChecksum: "" });
    const installer = new IosPrototypeInstaller({
      template: h.provider(),
      files: new FakeInstallerFileSystem(),
      plist: new FakePrototypePlist(),
      icons: new FakePrototypeIconRenderer(),
      simctl: new FakePrototypeSimctl(),
      data: new FakePrototypeDataWriter(),
      commands: new FakeHostCommandExecutor(),
    });
    const error = await installer
      .install({
        udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        prototypeId: "test",
        spec: { version: 1 },
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(errors.TemplateResolveError);
    if (!(error instanceof errors.TemplateResolveError)) {
      throw new Error("wrong error");
    }
    expect(error.cause).toBeInstanceOf(errors.PrototypeViewerUnsupportedVersionError);
    expect(error.message).toContain("prototype-viewer-build.sh");
    expect(error.message).toContain(IOS_PROTOTYPE_VIEWER_ENV);
  });
});
