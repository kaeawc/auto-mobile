import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ToolOutputArtifactLedger } from "../../src/server/toolOutputArtifactLedger";
import {
  TOOL_OUTPUT_RESOURCE_URI_TEMPLATE,
  buildToolOutputResourceUri,
  registerToolOutputResources,
  resetToolOutputResourceDependencies,
  setToolOutputResourceDependencies,
} from "../../src/server/toolOutputResources";

const ARTIFACT_DIR = path.resolve("/tmp/auto-mobile-tool-outputs");

class FakeResourceFileSystem {
  files = new Map<string, string>();
  reads: string[] = [];
  readError: Error | undefined;

  async readFile(filePath: string): Promise<string> {
    this.reads.push(filePath);
    if (this.readError) {
      throw this.readError;
    }
    const content = this.files.get(filePath);
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file '${filePath}'`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }
}

/**
 * Install a fake filesystem plus a provenance ledger seeded so the given
 * basenames resolve to `ARTIFACT_DIR/<basename>` — i.e. as if the writer had
 * issued them. The resource reads the path FROM the ledger, so a read is only
 * reachable for a recorded artifact.
 */
function installFake(fileSystem: FakeResourceFileSystem, issuedBasenames: string[] = []): void {
  const ledger = new ToolOutputArtifactLedger();
  for (const name of issuedBasenames) {
    ledger.record(path.join(ARTIFACT_DIR, name));
  }
  setToolOutputResourceDependencies({ fileSystem, ledger });
}

async function readArtifact(artifactId: string) {
  registerToolOutputResources();
  const uri = buildToolOutputResourceUri(artifactId);
  const match = ResourceRegistry.matchTemplate(uri);
  expect(match).toBeDefined();
  expect(match!.template.uriTemplate).toBe(TOOL_OUTPUT_RESOURCE_URI_TEMPLATE);
  if ("handler" in match!.template) {
    return match!.template.handler(match!.params);
  }
  throw new Error("tool-output resource must be a plain template handler");
}

describe("tool-output artifact resource (#5882)", () => {
  afterEach(() => {
    resetToolOutputResourceDependencies();
    ResourceRegistry.clearResources();
  });

  test("returns the spilled artifact JSON in-band", async () => {
    const fileSystem = new FakeResourceFileSystem();
    const filename = "1788020656886-observe-abc123.json";
    const raw = JSON.stringify({ viewHierarchy: { hierarchy: { node: { text: "Settings" } } } });
    fileSystem.files.set(path.join(ARTIFACT_DIR, filename), raw);
    installFake(fileSystem, [filename]);

    const content = await readArtifact(filename);

    expect(content.mimeType).toBe("application/json");
    expect(content.text).toBe(raw);
    expect(content.uri).toBe(buildToolOutputResourceUri(filename));
    expect(fileSystem.reads).toEqual([path.join(ARTIFACT_DIR, filename)]);
  });

  test("companion URI round-trips with the file basename", () => {
    const filename = "1-observe-id.json";
    expect(buildToolOutputResourceUri(filename)).toBe(`automobile:tool-output/${filename}`);
    const match =
      (registerToolOutputResources(),
      ResourceRegistry.matchTemplate(buildToolOutputResourceUri(filename)));
    expect(match?.params.artifactId).toBe(filename);
  });

  test("rejects path-traversal artifact ids without touching the filesystem", async () => {
    const fileSystem = new FakeResourceFileSystem();
    installFake(fileSystem);

    // A URI-template segment stops at "/", so a literal "../" cannot even match
    // the template; assert the handler still refuses a decoded traversal id.
    const traversal = "..%2f..%2fetc%2fpasswd";
    const content = await readArtifact(traversal);

    expect(content.text).toContain("Invalid tool-output artifact id");
    expect(fileSystem.reads).toEqual([]);
  });

  test("rejects non-json artifact ids", async () => {
    const fileSystem = new FakeResourceFileSystem();
    installFake(fileSystem);

    const content = await readArtifact("1-observe-id.txt");

    expect(content.text).toContain("Invalid tool-output artifact id");
    expect(fileSystem.reads).toEqual([]);
  });

  test("rejects sibling .json files that don't match the writer's filename shape", async () => {
    // A shared/misconfigured --tool-outputs-dir must not let a client read an
    // arbitrary guessable file just because it ends in .json (issue #5882 review).
    const fileSystem = new FakeResourceFileSystem();
    fileSystem.files.set(path.join(ARTIFACT_DIR, "credentials.json"), '{"secret":true}');
    installFake(fileSystem);

    const content = await readArtifact("credentials.json");

    expect(content.text).toContain("Invalid tool-output artifact id");
    expect(fileSystem.reads).toEqual([]);
  });

  test("rejects a writer-shaped id the writer never issued (provenance, #5917)", async () => {
    // Shape-valid AND sitting in the tool-outputs dir, but not in the ledger:
    // a hostile process could plant `<ts>-observe-<id>.json` in a world-writable
    // --tool-outputs-dir. Provenance tracking refuses it without a read.
    const fileSystem = new FakeResourceFileSystem();
    const planted = "1788020656886-observe-planted.json";
    fileSystem.files.set(path.join(ARTIFACT_DIR, planted), '{"secret":true}');
    installFake(fileSystem, []); // ledger empty — nothing issued

    const content = await readArtifact(planted);

    const parsed = JSON.parse(content.text!) as { error: string };
    expect(parsed.error).toContain("not available");
    expect(fileSystem.reads).toEqual([]);
  });

  test("returns a structured error when the artifact is issued but missing or pruned", async () => {
    const fileSystem = new FakeResourceFileSystem();
    const filename = "1788020656886-observe-gone.json";
    // Issued by the writer, but the file is gone (pruned/expired): reaches the
    // read, which fails, and surfaces the graceful error.
    installFake(fileSystem, [filename]);

    const content = await readArtifact(filename);

    expect(content.mimeType).toBe("application/json");
    const parsed = JSON.parse(content.text!) as { error: string };
    expect(parsed.error).toContain("not available");
    expect(fileSystem.reads).toEqual([path.join(ARTIFACT_DIR, filename)]);
  });

  // Unprivileged symlink creation is unavailable on Windows (needs admin/developer
  // mode), and O_NOFOLLOW degrades to a no-op there anyway, so this is POSIX-only.
  test.skipIf(process.platform === "win32")(
    "refuses to follow a symlink to a file outside the issued set (#5917)",
    async () => {
      // In a deliberately world-writable --tool-outputs-dir a foreign process could
      // plant a writer-shaped symlink pointing at an arbitrary file. The node read
      // opens with O_NOFOLLOW, so the symlink target is never served.
      const dir = mkdtempSync(path.join(tmpdir(), "auto-mobile-symlink-"));
      const secretPath = path.join(dir, "secret.txt");
      const filename = "1788020656886-observe-evil.json";
      const linkPath = path.join(dir, filename);
      try {
        writeFileSync(secretPath, "top secret");
        symlinkSync(secretPath, linkPath);

        // Real node filesystem (not the fake), but a ledger that has "issued" the
        // symlink path — provenance alone must not defeat symlink refusal.
        const ledger = new ToolOutputArtifactLedger();
        ledger.record(linkPath);
        setToolOutputResourceDependencies({ ledger });

        const content = await readArtifact(filename);

        const parsed = JSON.parse(content.text!) as { error: string };
        expect(parsed.error).toContain("not available");
        expect(content.text).not.toContain("top secret");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
