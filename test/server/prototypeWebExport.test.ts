import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import {
  prototypeResourceReadersModule,
  registerPrototypeResources,
  type PrototypeWebSources,
} from "../../src/server/prototypeResources";
import {
  exportPrototypeWeb,
  type PrototypeWebExportFiles,
  type PrototypeWebExportInput,
  type PrototypeWebExportPathKind,
} from "../../src/server/prototypeWebExport";
import {
  EXPORT_PROTOTYPE_WEB_TOOL_NAME,
  exportPrototypeWebSchema,
  registerPrototypeWebExportTool,
} from "../../src/server/prototypeWebExportTool";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

const URI = "automobile:prototype/checkout/web";
const spec = (text: string) => ({
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

/** In-memory files: a map of path to bytes, plus directories and paths that refuse writes. */
class FakeExportFiles implements PrototypeWebExportFiles {
  readonly written = new Map<string, Uint8Array>();
  readonly directories = new Set<string>(["/out"]);
  readonly unwritable = new Set<string>();
  writes = 0;

  defaultDir(): string {
    return "/data/prototype-web";
  }

  async kind(filePath: string): Promise<PrototypeWebExportPathKind | undefined> {
    if (this.directories.has(filePath)) {
      return "directory";
    }
    return this.written.has(filePath) ? "file" : undefined;
  }

  async read(filePath: string): Promise<Uint8Array> {
    return this.written.get(filePath)!;
  }

  async write(filePath: string, bytes: Uint8Array, options: { exclusive: boolean }) {
    if (this.unwritable.has(filePath)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), {
        code: "EACCES",
      });
    }
    if (options.exclusive && this.written.has(filePath)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }
    this.writes += 1;
    this.written.set(filePath, bytes);
  }
}

let snapshot: ReturnType<typeof ResourceRegistry.snapshotForTesting>;
let revisions: PrototypeSpecRevisions;
let sources: PrototypeWebSources;
let files: FakeExportFiles;
let server: FakeMcpServer;

async function readResource(
  uri: string,
): Promise<{ text: string; _meta: Record<string, unknown> }> {
  const handler = server.server.handlersBySchema.get("resources/read")!;
  const read = (await handler(
    { params: { uri } },
    { mcpReq: { signal: new AbortController().signal } },
  )) as { contents: { text: string; _meta: Record<string, unknown> }[] };
  return read.contents[0]!;
}

function exportWeb(input: PrototypeWebExportInput) {
  return exportPrototypeWeb(input, {
    readWeb: async (query) => (await prototypeResourceReadersModule.load()).readWeb(sources, query),
    files,
  });
}

describe("exportPrototypeWeb (#17720)", () => {
  isolateToolRegistry();

  beforeEach(() => {
    snapshot = ResourceRegistry.snapshotForTesting();
    ResourceRegistry.clearServersForTesting();
    revisions = new PrototypeSpecRevisions(new FakeTimer());
    sources = { revisions, rendererVersion: () => "9.9.9" };
    revisions.recordShow("checkout", { spec: spec("first"), platform: "android" });
    revisions.recordPatch("checkout", { spec: spec("second"), platform: "android" });
    registerPrototypeResources(undefined, sources);
    server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server);
    files = new FakeExportFiles();
  });

  afterEach(() => {
    ResourceRegistry.clearServersForTesting();
    ResourceRegistry.restoreForTesting(snapshot);
  });

  test("writes exactly the bytes the web resource returns for the same parameters", async () => {
    const cases: [PrototypeWebExportInput, string][] = [
      [{ id: "checkout" }, URI],
      [{ id: "checkout", revision: "1", frame: "pixel-9" }, `${URI}?revision=1&frame=pixel-9`],
    ];
    for (const [input, uri] of cases) {
      const resource = await readResource(uri);
      const result = await exportWeb({
        ...input,
        outputPath: `/out/r${input.revision ?? "x"}.html`,
      });
      const written = files.written.get(result.path)!;
      expect(Buffer.from(written).equals(Buffer.from(resource.text, "utf8"))).toBe(true);
      expect(result).toEqual({
        path: result.path,
        sha256: resource._meta.sha256 as string,
        bytes: written.length,
        frame: resource._meta.frame as string,
        revision: resource._meta.revision as number,
        variants: resource._meta.variants as string[],
        rendererVersion: "9.9.9",
      });
      expect(result.sha256).toBe(createHash("sha256").update(written).digest("hex"));
    }
  });

  test("keeps the resource's offline CSP", async () => {
    const result = await exportWeb({ id: "checkout" });
    const html = Buffer.from(files.written.get(result.path)!).toString("utf8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
  });

  test("defaults to a content-addressed name in the data directory, or inside a directory", async () => {
    const byDefault = await exportWeb({ id: "checkout" });
    const name = `checkout-${byDefault.frame}-r2-${byDefault.sha256.slice(0, 12)}.html`;
    expect(byDefault.path).toBe(path.join("/data/prototype-web", name));
    const inDirectory = await exportWeb({ id: "checkout", outputPath: "/out" });
    expect(inDirectory.path).toBe(path.join("/out", name));
  });

  test("refuses to replace a different file unless overwrite is set; identical bytes are kept", async () => {
    files.written.set("/out/page.html", new Uint8Array([1, 2, 3]));
    await expect(exportWeb({ id: "checkout", outputPath: "/out/page.html" })).rejects.toThrow(
      "already exists with different content; pass overwrite: true",
    );
    expect(Array.from(files.written.get("/out/page.html")!)).toEqual([1, 2, 3]);

    await exportWeb({ id: "checkout", outputPath: "/out/page.html", overwrite: true });
    expect(files.writes).toBe(1);
    await exportWeb({ id: "checkout", outputPath: "/out/page.html" });
    expect(files.writes).toBe(1);
  });

  test("refuses a relative path and reports an unwritable one", async () => {
    await expect(exportWeb({ id: "checkout", outputPath: "page.html" })).rejects.toThrow(
      "is not absolute",
    );
    files.unwritable.add("/locked/page.html");
    await expect(exportWeb({ id: "checkout", outputPath: "/locked/page.html" })).rejects.toThrow(
      "Cannot write the prototype web page to /locked/page.html (EACCES)",
    );
  });

  test("a file target must end in .html; a directory path may end in a separator", async () => {
    for (const outputPath of ["/out/page.txt", "/out/page", "/out/page.html.bak"]) {
      await expect(exportWeb({ id: "checkout", outputPath })).rejects.toThrow(
        `outputPath "${outputPath}" is neither an .html file nor a directory`,
      );
    }
    files.written.set("/out/notes.txt", new Uint8Array([1]));
    await expect(
      exportWeb({ id: "checkout", outputPath: "/out/notes.txt", overwrite: true }),
    ).rejects.toThrow("end a file path in .html");
    expect(files.writes).toBe(0);

    const upper = await exportWeb({ id: "checkout", outputPath: "/out/PAGE.HTML" });
    expect(upper.path).toBe("/out/PAGE.HTML");
    const intoNewDirectory = await exportWeb({ id: "checkout", outputPath: "/out/new/" });
    expect(path.dirname(intoNewDirectory.path)).toBe(path.join("/out", "new"));
  });

  test("unknown id, evicted or unknown revision and unknown frame are actionable", async () => {
    await expect(exportWeb({ id: "missing" })).rejects.toThrow('Unknown prototype "missing"');
    await expect(exportWeb({ id: "checkout", revision: "9" })).rejects.toThrow(
      "Kept revisions: 1, 2",
    );
    await expect(exportWeb({ id: "checkout", frame: "toaster" })).rejects.toThrow(
      'Unknown device frame "toaster". Valid frames:',
    );
    expect(files.writes).toBe(0);
  });

  test("a revision older than the kept 20 says it was evicted", async () => {
    for (let index = 0; index < 20; index += 1) {
      revisions.recordPatch("checkout", { spec: spec(`patch ${index}`) });
    }
    await expect(exportWeb({ id: "checkout", revision: "1" })).rejects.toThrow(
      'Revision 1 of prototype "checkout" was evicted',
    );
  });

  test("registers outside the default core set and answers with the result, not the HTML", async () => {
    try {
      registerPrototypeWebExportTool({ sources, files });
      const tool = ToolRegistry.getTool(EXPORT_PROTOTYPE_WEB_TOOL_NAME)!;
      expect(tool.defaultEnabled).toBe(false);
      expect(tool.requiresDevice).toBe(false);
      const response = (await tool.handler({ id: "checkout", outputPath: "/out/tool.html" })) as {
        structuredContent: { path: string; bytes: number };
      };
      expect(response.structuredContent).toMatchObject({ path: "/out/tool.html", revision: 2 });
      expect(JSON.stringify(response)).not.toContain("<html");
    } finally {
      ToolRegistry.unregister(EXPORT_PROTOTYPE_WEB_TOOL_NAME);
    }
    expect(Object.keys(exportPrototypeWebSchema.shape)).toEqual([
      "id",
      "frame",
      "revision",
      "variant",
      "mcpSessionId",
      "outputPath",
      "overwrite",
      "sessionUuid",
    ]);
  });
});
