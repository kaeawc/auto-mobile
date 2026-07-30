import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../src/models";
import { assertArchiveEntriesSafe, DefaultArchiveExtractor } from "../../src/utils/ArchiveExtractor";
import { ActionableError } from "../../src/models/ActionableError";
import type { HostCommandExecutor, HostCommandOptions } from "../../src/utils/HostCommandExecutor";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s)
  };
}

/** Records every invocation and returns the queued stdout for `tar -tzf` listings. */
class RecordingExecutor implements HostCommandExecutor {
  public readonly calls: Array<{ file: string; args: string[]; options?: HostCommandOptions }> = [];
  public listing = "";
  public extractError: Error | null = null;

  async executeCommand(file: string, args: string[] = [], options?: HostCommandOptions): Promise<ExecResult> {
    this.calls.push({ file, args, options });
    if (args[0] === "-tzf") {
      return execResult(this.listing);
    }
    if (this.extractError) {
      throw this.extractError;
    }
    return execResult("");
  }
}

describe("assertArchiveEntriesSafe", () => {
  test("accepts ordinary relative entries", () => {
    expect(() => assertArchiveEntriesSafe(
      ["libwebp-1.6.0/", "libwebp-1.6.0/bin/cwebp", "libwebp-1.6.0/README"],
      "/tmp/dest"
    )).not.toThrow();
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
    expect(() => assertArchiveEntriesSafe(["/etc/cron.d/evil"], "/tmp/dest")).toThrow(ActionableError);
  });

  test("rejects a Windows drive-qualified entry", () => {
    expect(() => assertArchiveEntriesSafe(["C:\\Windows\\System32\\evil"], "/tmp/dest")).toThrow(ActionableError);
  });

  test("allows an inner '..' that stays within the destination", () => {
    expect(() => assertArchiveEntriesSafe(["a/b/../c/file"], "/tmp/dest")).not.toThrow();
  });

  test("ignores blank listing lines", () => {
    expect(() => assertArchiveEntriesSafe(["", "  ", "libwebp/bin/cwebp"], "/tmp/dest")).not.toThrow();
  });
});

describe("DefaultArchiveExtractor", () => {
  test("lists before extracting and passes argv-first tar commands", async () => {
    const executor = new RecordingExecutor();
    executor.listing = "libwebp-1.6.0/\nlibwebp-1.6.0/bin/cwebp\n";
    const extractor = new DefaultArchiveExtractor(executor);

    await extractor.extractTarGz({ archivePath: "/tmp/a b/archive.tar.gz", destinationDir: "/tmp/dest" });

    expect(executor.calls[0].file).toBe("tar");
    expect(executor.calls[0].args).toEqual(["-tzf", "/tmp/a b/archive.tar.gz"]);
    expect(executor.calls[1].args).toEqual(["-xzf", "/tmp/a b/archive.tar.gz", "-C", "/tmp/dest"]);
  });

  test("rejects a traversal entry before running extraction", async () => {
    const executor = new RecordingExecutor();
    executor.listing = "../../escape";
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir: "/tmp/dest" })
      .catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    // Only the listing call ran; extraction was never attempted.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].args[0]).toBe("-tzf");
  });

  test("wraps extraction failures in an actionable error", async () => {
    const executor = new RecordingExecutor();
    executor.listing = "libwebp/bin/cwebp";
    executor.extractError = new Error("tar: unexpected end of file");
    const extractor = new DefaultArchiveExtractor(executor);

    const thrown = await extractor
      .extractTarGz({ archivePath: "/tmp/archive.tar.gz", destinationDir: "/tmp/dest" })
      .catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("Failed to extract archive");
  });

  test("forwards timeout and signal to the executor", async () => {
    const executor = new RecordingExecutor();
    executor.listing = "libwebp/bin/cwebp";
    const extractor = new DefaultArchiveExtractor(executor);
    const controller = new AbortController();

    await extractor.extractTarGz({
      archivePath: "/tmp/archive.tar.gz",
      destinationDir: "/tmp/dest",
      timeoutMs: 5000,
      signal: controller.signal
    });

    for (const call of executor.calls) {
      expect(call.options?.timeoutMs).toBe(5000);
      expect(call.options?.signal).toBe(controller.signal);
    }
  });
});
