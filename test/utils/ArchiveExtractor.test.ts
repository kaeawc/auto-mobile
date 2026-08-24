import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult } from "../../src/models";
import {
  assertArchiveEntriesSafe,
  DefaultArchiveExtractor,
} from "../../src/utils/ArchiveExtractor";
import { ActionableError } from "../../src/models/ActionableError";
import type { HostCommandExecutor, HostCommandOptions } from "../../src/utils/HostCommandExecutor";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-archive-extractor-"));
  tempDirs.push(dir);
  // realpath so assertions compare against the canonical path tar's -C receives.
  return fs.realpath(dir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

/**
 * Records every invocation, returns the queued stdout for `tar -tzf` listings,
 * and simulates a real `tar -x` by materializing `filesToWrite` inside the
 * `-C` directory it is handed (the staging dir).
 */
class RecordingExecutor implements HostCommandExecutor {
  public readonly calls: Array<{ file: string; args: string[]; options?: HostCommandOptions }> = [];
  public listing = "";
  public listError: Error | null = null;
  public extractError: Error | null = null;
  public filesToWrite: string[] = [];
  // Symlink members tar would create in the staging dir (name-only listings hide these).
  public symlinksToWrite: Array<{ path: string; target: string }> = [];
  // Mode a malicious `./` member would leave on the staging dir after extraction.
  public stagingModeAfterExtract: number | null = null;

  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    this.calls.push({ file, args, options });
    if (args[0] === "-tzf") {
      if (this.listError) {
        throw this.listError;
      }
      return execResult(this.listing);
    }
    if (this.extractError) {
      throw this.extractError;
    }
    const dashC = args.indexOf("-C");
    const destDir = dashC >= 0 ? args[dashC + 1] : ".";
    for (const rel of this.filesToWrite) {
      const target = path.join(destDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, "payload", { mode: 0o600 });
    }
    for (const link of this.symlinksToWrite) {
      const linkPath = path.join(destDir, link.path);
      await fs.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o700 });
      await fs.symlink(link.target, linkPath);
    }
    if (this.stagingModeAfterExtract !== null) {
      await fs.chmod(destDir, this.stagingModeAfterExtract);
    }
    return execResult("");
  }
}

describe("assertArchiveEntriesSafe", () => {
  test("accepts ordinary relative entries", () => {
    expect(() =>
      assertArchiveEntriesSafe(
        ["libwebp-1.6.0/", "libwebp-1.6.0/bin/cwebp", "libwebp-1.6.0/README"],
        "/tmp/dest",
      ),
    ).not.toThrow();
  });

  test("rejects a parent-directory traversal entry (zip-slip)", () => {
    const thrown = (() => {
      try {
        assertArchiveEntriesSafe(["../../etc/passwd"], "/tmp/dest");
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("path traversal");
  });

  test("rejects an absolute POSIX path entry", () => {
    expect(() => assertArchiveEntriesSafe(["/etc/cron.d/evil"], "/tmp/dest")).toThrow(
      ActionableError,
    );
  });

  test("rejects a Windows drive-qualified entry", () => {
    expect(() => assertArchiveEntriesSafe(["C:\\Windows\\System32\\evil"], "/tmp/dest")).toThrow(
      ActionableError,
    );
  });

  test("allows an inner '..' that stays within the destination", () => {
    expect(() => assertArchiveEntriesSafe(["a/b/../c/file"], "/tmp/dest")).not.toThrow();
  });

  test("ignores blank listing lines", () => {
    expect(() =>
      assertArchiveEntriesSafe(["", "  ", "libwebp/bin/cwebp"], "/tmp/dest"),
    ).not.toThrow();
  });
});

describe("DefaultArchiveExtractor", () => {
  test("lists first, extracts argv-first into a staging dir, then moves results into place", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    executor.listing = "libwebp-1.6.0/\nlibwebp-1.6.0/bin/cwebp\n";
    executor.filesToWrite = ["libwebp-1.6.0/bin/cwebp"];
    const extractor = new DefaultArchiveExtractor(executor);

    // The extractor resolves the archive path; assert against the resolved form so
    // the expectation holds on Windows (where a POSIX-style path gains a drive).
    const archivePath = "/tmp/a b/archive.tar.gz";
    const resolvedArchivePath = path.resolve(archivePath);
    await extractor.extractTarGz({ archivePath, destinationDir });

    // Listing precedes extraction, both argv-first (no shell string).
    expect(executor.calls[0].file).toBe("tar");
    expect(executor.calls[0].args).toEqual(["-tzf", resolvedArchivePath]);
    expect(executor.calls[1].args[0]).toBe("-xzf");
    expect(executor.calls[1].args[1]).toBe(resolvedArchivePath);
    expect(executor.calls[1].args[2]).toBe("-C");
    // Extraction targets a fresh staging dir inside the destination, not the destination itself.
    const stagingDir = executor.calls[1].args[3];
    expect(path.dirname(stagingDir)).toBe(destinationDir);
    expect(path.basename(stagingDir).startsWith(".am-extract-")).toBe(true);

    // Results landed in the destination and the staging dir was cleaned up.
    expect(
      await fs.readFile(path.join(destinationDir, "libwebp-1.6.0", "bin", "cwebp"), "utf8"),
    ).toBe("payload");
    expect(await fs.readdir(destinationDir)).toEqual(["libwebp-1.6.0"]);
  });

  test("confines extraction to the destination even when the destination's parent is a symlink", async () => {
    const base = await makeTempDir();
    const realParent = path.join(base, "real-parent");
    const outside = path.join(base, "outside");
    await fs.mkdir(realParent, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    // `linkedParent` is a symlink standing in for a symlinked ancestor of the destination.
    const linkedParent = path.join(base, "linked-parent");
    await fs.symlink(realParent, linkedParent);
    const destinationDir = path.join(linkedParent, "dest");

    const executor = new RecordingExecutor();
    executor.listing = "pkg/bin/tool";
    executor.filesToWrite = ["pkg/bin/tool"];
    const extractor = new DefaultArchiveExtractor(executor);

    await extractor.extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir });

    // Every tar write went through the realpath'd staging dir, never the symlinked path.
    const stagingDir = executor.calls[1].args[3];
    expect(stagingDir.startsWith(realParent)).toBe(true);
    expect(stagingDir.includes(`${path.sep}linked-parent${path.sep}`)).toBe(false);

    // The file resolves to the real destination and nothing escaped into a sibling tree.
    const landed = path.join(realParent, "dest", "pkg", "bin", "tool");
    expect(await fs.readFile(landed, "utf8")).toBe("payload");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test("rejects a traversal entry before running extraction", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    executor.listing = "../../escape";
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir })
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    // Only the listing call ran; extraction was never attempted.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].args[0]).toBe("-tzf");
  });

  test("wraps extraction failures in an actionable error and cleans up staging", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    executor.listing = "libwebp/bin/cwebp";
    executor.extractError = new Error("tar: unexpected end of file");
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir })
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("Failed to extract archive");
    // Staging dir removed on the failure path — destination left empty.
    expect(await fs.readdir(destinationDir)).toEqual([]);
  });

  test("forwards timeout and signal to the executor", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    executor.listing = "libwebp/bin/cwebp";
    const extractor = new DefaultArchiveExtractor(executor);
    const controller = new AbortController();

    await extractor.extractTarGz({
      archivePath: "/tmp/archive.tar.gz",
      destinationDir,
      timeoutMs: 5000,
      signal: controller.signal,
    });

    for (const call of executor.calls) {
      expect(call.options?.timeoutMs).toBe(5000);
      expect(call.options?.signal).toBe(controller.signal);
    }
  });

  test("wraps a failing listing (missing or corrupt archive) in an actionable error", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    executor.listError = new Error("tar: Error opening archive: Unrecognized archive format");
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir })
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("missing or corrupt");
    // Listing failed, so extraction was never attempted and nothing was written.
    expect(executor.calls).toHaveLength(1);
    expect(await fs.readdir(destinationDir)).toEqual([]);
  });

  test("rejects a top-level symlink member outright", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    // `tar -tzf` reports only the benign member name; the symlink type is hidden.
    executor.listing = "pkg/\npkg/tool";
    executor.symlinksToWrite = [{ path: "pkg/tool", target: "../../../outside/payload" }];
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir })
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("symlinks are not permitted");
    // Nothing landed: the staging tree was cleaned up, destination left empty.
    expect(await fs.readdir(destinationDir)).toEqual([]);
  });

  test("rejects a nested symlink member", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    executor.listing = "pkg/\npkg/lib/\npkg/lib/tool";
    executor.symlinksToWrite = [{ path: "pkg/lib/tool", target: "../shared/file" }];
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir })
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("symlinks are not permitted");
    expect(await fs.readdir(destinationDir)).toEqual([]);
  });

  test("rejects a symlink member even when its lexical target looks in-bounds", async () => {
    // The dangerous escapes (a `..` collapsing across a symlink, a dangling
    // destination symlink) all disguise the target as internal. Rejecting every
    // link member removes the need to prove any single target stays contained.
    const base = await makeTempDir();
    const destinationDir = path.join(base, "dest");
    await fs.mkdir(destinationDir, { recursive: true });
    // A pre-existing destination symlink an in-bounds-looking target could ride.
    await fs.symlink("../outside", path.join(destinationDir, "trusted"));

    const executor = new RecordingExecutor();
    executor.listing = "tool";
    executor.symlinksToWrite = [{ path: "tool", target: "trusted/payload" }];
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir })
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("symlinks are not permitted");
    // The link never landed; only the pre-existing `trusted` remains.
    expect(await fs.readdir(destinationDir)).toEqual(["trusted"]);
  });

  test("recovers when a malicious `./` member leaves the staging dir unwritable", async () => {
    const destinationDir = await makeTempDir();
    const executor = new RecordingExecutor();
    executor.listing = "pkg/\npkg/bin/tool";
    executor.filesToWrite = ["pkg/bin/tool"];
    // tar applies a `0555` `./` member's mode to the staging root, which would break
    // both the rename out and the best-effort cleanup unless permissions are restored.
    executor.stagingModeAfterExtract = 0o555;
    const extractor = new DefaultArchiveExtractor(executor);

    await extractor.extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir });

    // Results landed and no `.am-extract-*` staging tree was stranded.
    expect(await fs.readFile(path.join(destinationDir, "pkg", "bin", "tool"), "utf8")).toBe(
      "payload",
    );
    expect(await fs.readdir(destinationDir)).toEqual(["pkg"]);
  });
});
