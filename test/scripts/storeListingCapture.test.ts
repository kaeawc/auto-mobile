import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureShots,
  compareTrees,
  screenshotFromOutput,
  selectShots,
  type CaptureRunner,
} from "../../scripts/store-listing/captureRunner";
import { runDrive } from "../../scripts/mcp-drive";
import { main } from "../../scripts/store-listing/capture-screenshots";
import { buildScreenshotPlan } from "../../scripts/store-listing/screenshotPlan";

const shots = buildScreenshotPlan({ androidSerial: "serial", iosUdid: "udid" });
class FakeRunner implements CaptureRunner {
  calls: string[][] = [];
  output =
    '### observe: summary\n{"structuredContent":{"screenshotPath":"/capture.png"}}\nsession: uuid\n';
  fail = false;
  async run(argv: string[]) {
    this.calls.push(argv);
    if (this.fail) {
      throw new Error("process failed");
    }
    return this.output;
  }
}
// Minimal PNG header for the existing header reader; no image rendering or device I/O.
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("reads observe's JSON envelope, never a guessed summary path", () => {
  expect(screenshotFromOutput(new FakeRunner().output)).toBe("/capture.png");
  expect(() => screenshotFromOutput('### observe: {}\n{"structuredContent":{}}\n')).toThrow(
    "screenshotPath",
  );
});

test("filters shots and rejects typos and missing platform pins", () => {
  expect(selectShots({ androidSerial: "serial" }, "android-phone")).toHaveLength(8);
  expect(selectShots({ androidSerial: "serial" }, undefined, shots[0]!.id)).toHaveLength(1);
  expect(() => selectShots({ androidSerial: "serial" }, "typo")).toThrow();
  expect(() => selectShots({ androidSerial: "serial" }, "ios-iphone-69")).toThrow("ios-udid");
});

test("runs pinned host steps then a private drive plan and writes only correctly sized PNGs", async () => {
  const runner = new FakeRunner();
  const writes = new Map<string, string | Buffer>();
  await captureShots([shots[0]!], "/out", "/plans", runner, {
    read: () => png(1080, 2400),
    write: (path, data) => {
      writes.set(path, data);
    },
  });
  const planPath = join("/plans", "android-phone-light-library.plan.json");
  expect(runner.calls[0]).toEqual(["adb", "-s", "serial", "shell", "cmd", "uimode", "night", "no"]);
  expect(runner.calls[1]).toEqual([
    "bun",
    "scripts/mcp-drive.ts",
    "--private",
    "--json",
    "--plan",
    planPath,
  ]);
  const plan = JSON.parse(String(writes.get(planPath)));
  expect(plan.at(-1).tool).toBe("observe");
  expect(writes.get(join("/out", shots[0]!.destination))).toEqual(png(1080, 2400));
});

test("rejects dimensions, non-PNG, missing evidence and process errors before writing a screenshot", async () => {
  for (const bytes of [png(1, 2), Buffer.from("not a png")]) {
    const writes: string[] = [];
    await expect(
      captureShots([shots[0]!], "/out", "/plans", new FakeRunner(), {
        read: () => bytes,
        write: (path) => {
          writes.push(path);
        },
      }),
    ).rejects.toThrow("PNG");
    expect(writes).toHaveLength(1);
  }
  const runner = new FakeRunner();
  runner.fail = true;
  await expect(
    captureShots([shots[0]!], "/out", "/plans", runner, {
      read: () => {
        throw new Error("must not read");
      },
      write: () => {},
    }),
  ).rejects.toThrow("process failed");
  expect(runner.calls).toHaveLength(1);
});

test("compares every file by SHA256 and reports changed, missing and extra paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "listing-compare-"));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(join(a, "nested"), { recursive: true });
    mkdirSync(join(b, "nested"), { recursive: true });
    writeFileSync(join(a, "nested/same"), "same");
    writeFileSync(join(b, "nested/same"), "same");
    expect(compareTrees(a, b)).toEqual([]);
    expect(await main(["--verify-identical", a, b])).toBe(0);
    writeFileSync(join(a, "changed"), "a");
    writeFileSync(join(b, "changed"), "b");
    writeFileSync(join(a, "missing"), "a");
    writeFileSync(join(b, "extra"), "b");
    expect(compareTrees(a, b)).toEqual([
      "changed: different sha256",
      "extra: missing from first tree",
      "missing: missing from second tree",
    ]);
    expect(await main(["--verify-identical", a, b])).toBe(1);
    expect(readFileSync(join(a, "changed"), "utf8")).toBe("a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consumes the real mcp-drive log contract with a fake MCP client", async () => {
  const logs: string[] = [];
  await runDrive(
    { json: true, quiet: false, steps: [{ tool: "observe", args: {} }] },
    {
      defaultServerPath: () => "/unused",
      log: (line) => {
        logs.push(line);
      },
      createClient: async () => ({
        callTool: async () => ({
          content: [{ type: "text", text: JSON.stringify({ screenshotPath: "/actual.png" }) }],
        }),
        close: async () => {},
      }),
    },
  );
  expect(screenshotFromOutput(logs.join("\n"))).toBe("/actual.png");
});
