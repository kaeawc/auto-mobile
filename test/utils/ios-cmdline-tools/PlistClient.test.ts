import { describe, expect, test } from "bun:test";
import { PlistClient, type PlistProcess } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("PlistClient", () => {
  test("converts a file to structured JSON through literal argv", async () => {
    const calls: Array<{ args: string[]; input?: Buffer }> = [];
    const process: PlistProcess = async (request) => {
      calls.push(request);
      return {
        stdout: Buffer.from('{"CFBundleIdentifier":"com.example.app"}'),
        stderr: Buffer.alloc(0),
      };
    };

    const plist = new PlistClient(process);
    await expect(plist.readJsonFile("/tmp/a;not-a-command/Info.plist")).resolves.toEqual({
      CFBundleIdentifier: "com.example.app",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "-convert",
      "json",
      "-o",
      "-",
      "--",
      "/tmp/a;not-a-command/Info.plist",
    ]);
  });

  test("converts bytes through stdin without a temporary file", async () => {
    const input = Buffer.from("binary plist bytes");
    const process: PlistProcess = async (request) => {
      expect(request.args).toEqual(["-convert", "json", "-o", "-", "--", "-"]);
      expect(request.input).toEqual(input);
      return {
        stdout: Buffer.from('{"com.apple.Maps":{"bundleName":"Maps"}}'),
        stderr: Buffer.alloc(0),
      };
    };

    await expect(new PlistClient(process).readJsonBytes(input)).resolves.toEqual({
      "com.apple.Maps": { bundleName: "Maps" },
    });
  });

  test("rejects malformed conversion output with actionable context", async () => {
    const process: PlistProcess = async () => ({
      stdout: Buffer.from("not json"),
      stderr: Buffer.alloc(0),
    });

    await expect(new PlistClient(process).readJsonFile("/tmp/bad.plist")).rejects.toThrow(
      "plutil produced malformed JSON",
    );
  });

  test("bounds oversized output before parsing", async () => {
    const process: PlistProcess = async () => ({
      stdout: Buffer.alloc(17),
      stderr: Buffer.alloc(0),
    });
    const plist = new PlistClient(process, { maxOutputBytes: 16 });

    await expect(plist.readJsonFile("/tmp/large.plist")).rejects.toThrow(
      "output exceeded 16 bytes",
    );
  });

  test("reports unavailable when the owner process cannot start", async () => {
    const process: PlistProcess = async () => {
      throw new Error("ENOENT: plutil");
    };

    await expect(new PlistClient(process).isAvailable()).resolves.toBe(false);
  });

  test("aborts the injected child process on the owner timeout", async () => {
    const timer = new FakeTimer();
    let aborted = false;
    const process: PlistProcess = (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const read = new PlistClient(process, { timeoutMs: 25, timer }).readJsonFile(
      "/tmp/wedged.plist",
    );

    timer.advanceTime(25);
    await expect(read).rejects.toThrow("timed out after 25ms");
    expect(aborted).toBe(true);
  });

  test("forwards caller cancellation to the injected child process", async () => {
    const controller = new AbortController();
    let aborted = false;
    const process: PlistProcess = (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const read = new PlistClient(process).readJsonFile("/tmp/cancelled.plist", {
      signal: controller.signal,
    });

    controller.abort();
    await expect(read).rejects.toThrow("plutil failed");
    expect(aborted).toBe(true);
  });
});
