import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLogStream } from "../../src/utils/logger";

describe("real fs.WriteStream close ordering contract (#6700)", () => {
  /**
   * Records the ACTUAL event ordering a real `fs.WriteStream` delivers on
   * this runtime, so a Bun/Node upgrade that reorders finish/error/close (or
   * flips `closed` early) fails this test directly instead of surfacing only
   * as a mysterious rotation/shutdown hang.
   */
  test("end() sequences finish before close, and 'closed' only flips once 'close' fires", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "am-logger-close-contract-"));
    const target = join(dir, "contract.log");
    const stream = fs.createWriteStream(target, { flags: "a" });
    try {
      const events: string[] = [];
      let errorSeen: Error | undefined;
      stream.on("error", (error: Error) => {
        errorSeen = error;
        events.push("error");
      });
      const closedAtFinish = new Promise<boolean>((resolve) => {
        stream.once("finish", () => {
          events.push("finish");
          resolve(stream.closed ?? false);
        });
      });
      const closeEvent = new Promise<void>((resolve) => {
        stream.once("close", () => {
          events.push("close");
          resolve();
        });
      });

      stream.write("contract line\n");
      stream.end();

      await closeEvent;

      expect(errorSeen).toBeUndefined();
      // The fd must NOT be released yet when `finish` fires — only `close`
      // confirms that. If a runtime upgrade flips this, closeLogStream's
      // close-before-reopen guarantee (#6149) no longer holds.
      expect(await closedAtFinish).toBeFalse();
      expect(stream.closed).toBeTrue();
      expect(events).toEqual(["finish", "close"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closeLogStream resolves against a real WriteStream once the fd is actually released", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "am-logger-close-contract-"));
    const target = join(dir, "contract-real.log");
    const stream = fs.createWriteStream(target, { flags: "a" });
    try {
      stream.write("line\n");
      await closeLogStream(stream);
      expect(stream.closed).toBeTrue();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
