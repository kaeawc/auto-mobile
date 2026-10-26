import { expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { BoundedByteWindow, collectBoundedStdout } from "../../src/server/boundedChildOutput";
import { StreamingChildProcess } from "../fakes/StreamingChildProcess";

for (const retain of ["head", "tail"] as const) {
  test(`${retain} retains a bounded byte window and counts all streamed bytes`, async () => {
    const child = new StreamingChildProcess();
    const pending = collectBoundedStdout(child, { maxBytes: 8, retain });
    child.stdout.write("first\n");
    child.stdout.write("last\n");
    child.finish();
    expect(await pending).toEqual({
      text: retain === "head" ? "first\nla" : "last\n",
      totalBytes: 11,
    });
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  test(`${retain} decodes multibyte UTF-8 split across chunks`, async () => {
    const child = new StreamingChildProcess();
    const pending = collectBoundedStdout(child, { maxBytes: 10, retain });
    const bytes = Buffer.from("a😀é\n");
    for (const byte of bytes) {
      child.stdout.write(Buffer.from([byte]));
    }
    child.finish();
    expect(await pending).toEqual({ text: "a😀é\n", totalBytes: bytes.length });
  });

  test(`${retain} never retains more than the byte bound`, () => {
    const window = new BoundedByteWindow(17, retain);
    for (let i = 0; i < 100; i++) {
      window.append(Buffer.alloc(i * 20, 97));
      expect(window.byteLength).toBeLessThanOrEqual(17);
    }
    expect(window.bytes().length).toBe(17);
  });
}

test("tail keeps a whole first line when truncation lands on a newline boundary", async () => {
  const child = new StreamingChildProcess();
  const pending = collectBoundedStdout(child, { maxBytes: 5, retain: "tail" });
  child.stdout.write("first\nlast\n");
  child.finish();
  expect((await pending).text).toBe("last\n");
});

test("head drops an incomplete UTF-8 suffix at the byte bound", async () => {
  const child = new StreamingChildProcess();
  const pending = collectBoundedStdout(child, { maxBytes: 3, retain: "head" });
  child.stdout.write("a😀");
  child.finish();
  expect((await pending).text).toBe("a");
});

test("nonzero exit includes only bounded stderr tail", async () => {
  const child = new StreamingChildProcess();
  const pending = collectBoundedStdout(child, { maxBytes: 5, retain: "head" });
  child.stderr.write("old-prefix" + "x".repeat(10_000) + " permission denied");
  child.finish(1);
  await expect(pending).rejects.toBeInstanceOf(ActionableError);
  await expect(pending).rejects.toThrow("permission denied");
  await expect(pending).rejects.not.toThrow("old-prefix");
  expect(child.stderr.listenerCount("data")).toBe(0);
});

test("spawn error includes stderr and cleans listeners", async () => {
  const child = new StreamingChildProcess();
  const pending = collectBoundedStdout(child, { maxBytes: 5, retain: "tail" });
  child.stderr.write("launch detail");
  child.emit("error", new Error("spawn failed"));
  await expect(pending).rejects.toThrow("spawn failed");
  await expect(pending).rejects.toThrow("launch detail");
  expect(child.listenerCount("error")).toBe(0);
});

for (const alreadyAborted of [true, false]) {
  test(`abort kills child and preserves reason (already aborted: ${alreadyAborted})`, async () => {
    const child = new StreamingChildProcess();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    if (alreadyAborted) {
      controller.abort(reason);
    }
    const pending = collectBoundedStdout(child, {
      maxBytes: 5,
      retain: "tail",
      signal: controller.signal,
    });
    if (!alreadyAborted) {
      controller.abort(reason);
    }
    await expect(pending).rejects.toBe(reason);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
  });
}

for (const retain of ["head", "tail"] as const) {
  test(`${retain} ring matches reference bytes through repeated wraps and snapshots`, () => {
    const window = new BoundedByteWindow(17, retain);
    let all = Buffer.alloc(0);
    for (let i = 0; i < 40; i++) {
      const chunk = Buffer.from(`chunk-${i}\n`);
      all = Buffer.concat([all, chunk]);
      window.append(chunk);
      expect(window.byteLength).toBeLessThanOrEqual(17);
      expect(window.bytes()).toEqual(retain === "head" ? all.subarray(0, 17) : all.subarray(-17));
    }
  });
}

test("tail drops an entire partial line when no newline remains", async () => {
  const child = new StreamingChildProcess();
  const pending = collectBoundedStdout(child, { maxBytes: 3, retain: "tail" });
  child.stdout.write("very long line");
  child.finish();
  expect(await pending).toEqual({ text: "", totalBytes: 14 });
});
