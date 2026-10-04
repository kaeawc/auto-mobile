import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { logger } from "../../src/utils/logger";

class FakeDownloadFileSystem {
  readonly files = new Map<string, Buffer>();
  readonly mkdirCalls: Array<{ path: string; recursive: boolean | undefined }> = [];
  readonly renameCalls: Array<{ from: string; to: string }> = [];
  readonly rmCalls: Array<{ path: string; force: boolean | undefined }> = [];
  rmError: Error | undefined;

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.mkdirCalls.push({ path, recursive: options?.recursive });
  }

  async rename(from: string, to: string): Promise<void> {
    this.renameCalls.push({ from, to });
    const contents = this.files.get(from);
    if (contents) {
      this.files.set(to, contents);
      this.files.delete(from);
    }
  }

  async rm(path: string, options?: { force?: boolean }): Promise<void> {
    this.rmCalls.push({ path, force: options?.force });
    if (this.rmError) {
      throw this.rmError;
    }
    this.files.delete(path);
  }
}

const tempPathFromArgs = (command: string, args: string[]): string => {
  const outputArg = command === "curl" ? "-o" : "-O";
  const outputIndex = args.indexOf(outputArg);
  if (outputIndex < 0 || !args[outputIndex + 1]) {
    throw new Error(`${command} output path was not provided`);
  }
  return args[outputIndex + 1];
};

afterEach(() => {
  mock.restore();
});

describe("DefaultFileDownloader atomic command downloads", () => {
  test("curl writes to an ID-generated temp path and renames it to destination", async () => {
    const fileSystem = new FakeDownloadFileSystem();
    const payload = Buffer.from("curl payload");
    const execute = mock(async (command: string, args: string[]) => {
      expect(command).toBe("curl");
      const tempPath = tempPathFromArgs(command, args);
      fileSystem.files.set(tempPath, payload);
    });
    const destination = "/cache/archive.zip";
    const downloader = new DefaultFileDownloader(
      new CountingIdGenerator("attempt"),
      execute,
      fileSystem,
    );

    await downloader.download("https://example.com/archive.zip", destination);

    const tempPath = `${destination}.download-attempt-1.tmp`;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toContain(tempPath);
    expect(fileSystem.renameCalls).toEqual([{ from: tempPath, to: destination }]);
    expect(fileSystem.files.get(destination)).toEqual(payload);
    expect(fileSystem.files.has(tempPath)).toBe(false);
  });

  test("wget writes to a temp path and renames it to destination when curl is unavailable", async () => {
    const fileSystem = new FakeDownloadFileSystem();
    const payload = Buffer.from("wget payload");
    const execute = mock(async (command: string, args: string[]) => {
      if (command === "curl") {
        throw Object.assign(new Error("curl not found"), { code: "ENOENT" });
      }
      const tempPath = tempPathFromArgs(command, args);
      fileSystem.files.set(tempPath, payload);
    });
    const destination = "/cache/archive.zip";
    const downloader = new DefaultFileDownloader(
      new CountingIdGenerator("attempt"),
      execute,
      fileSystem,
    );

    await downloader.download("https://example.com/archive.zip", destination);

    const tempPath = `${destination}.download-attempt-1.tmp`;
    expect(execute.mock.calls.map(([command]) => command)).toEqual(["curl", "wget"]);
    expect(execute.mock.calls[1]?.[1]).toContain(tempPath);
    expect(fileSystem.renameCalls).toEqual([{ from: tempPath, to: destination }]);
    expect(fileSystem.files.get(destination)).toEqual(payload);
    expect(fileSystem.files.has(tempPath)).toBe(false);
  });

  test("failure removes only its temp file and preserves the existing destination", async () => {
    const fileSystem = new FakeDownloadFileSystem();
    const destination = "/cache/archive.zip";
    const existingPayload = Buffer.from("known good archive");
    fileSystem.files.set(destination, existingPayload);
    const execute = mock(async (command: string, args: string[]) => {
      fileSystem.files.set(tempPathFromArgs(command, args), Buffer.from("partial archive"));
      throw new Error("transfer interrupted");
    });
    const downloader = new DefaultFileDownloader(
      new CountingIdGenerator("attempt"),
      execute,
      fileSystem,
    );

    await expect(
      downloader.download("https://example.com/archive.zip", destination),
    ).rejects.toThrow("transfer interrupted");

    const tempPath = `${destination}.download-attempt-1.tmp`;
    expect(fileSystem.files.get(destination)).toEqual(existingPayload);
    expect(fileSystem.files.has(tempPath)).toBe(false);
    expect(fileSystem.rmCalls).toEqual([{ path: tempPath, force: true }]);
    expect(fileSystem.renameCalls).toEqual([]);
  });

  test("warns if failed download temp cleanup also fails", async () => {
    const fileSystem = new FakeDownloadFileSystem();
    fileSystem.rmError = new Error("permission denied");
    const execute = mock(async () => {
      throw new Error("transfer interrupted");
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const downloader = new DefaultFileDownloader(
      new CountingIdGenerator("attempt"),
      execute,
      fileSystem,
    );

    await expect(
      downloader.download("https://example.com/archive.zip", "/cache/archive.zip"),
    ).rejects.toThrow("transfer interrupted");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to remove partial download"));
  });
});

describe("DefaultFileDownloader unavailable-command classification", () => {
  test.each([
    ["ENOENT", Object.assign(new Error("missing"), { code: "ENOENT" }), true],
    ["numeric exit", { code: 127 }, true],
    ["string exit", { code: "127" }, true],
    ["shell message", new Error("COMMAND NOT FOUND"), true],
    ["Windows message", { stderr: "not recognized as an internal or external command" }, true],
    ["command prefix", new Error("curl: not found"), true],
    ["command suffix", { stderr: "not found: curl" }, true],
    ["transfer error", new Error("connection reset"), false],
    ["other exit", { code: 22 }, false],
    ["empty object", {}, false],
    ["null", null, false],
    ["primitive", "command not found", false],
  ] as const)(
    "classifies %s without changing fallback order",
    async (_name, error, unavailable) => {
      const fileSystem = new FakeDownloadFileSystem();
      const execute = mock(async (command: string, args: string[]) => {
        if (command === "curl") {
          throw error;
        }
        fileSystem.files.set(tempPathFromArgs(command, args), Buffer.from("payload"));
      });
      const downloader = new DefaultFileDownloader(
        new CountingIdGenerator("attempt"),
        execute,
        fileSystem,
      );
      if (unavailable) {
        await downloader.download("https://example.com/archive.zip", "/cache/archive.zip");
        expect(execute.mock.calls.map(([command]) => command)).toEqual(["curl", "wget"]);
        expect(fileSystem.renameCalls).toEqual([
          { from: "/cache/archive.zip.download-attempt-1.tmp", to: "/cache/archive.zip" },
        ]);
      } else {
        await expect(
          downloader.download("https://example.com/archive.zip", "/cache/archive.zip"),
        ).rejects.toThrow("Download failed");
        expect(execute.mock.calls.map(([command]) => command)).toEqual(["curl"]);
        expect(fileSystem.renameCalls).toEqual([]);
      }
    },
  );
});
