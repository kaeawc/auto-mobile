import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
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

function installFake(fileSystem: FakeResourceFileSystem): void {
  setToolOutputResourceDependencies({
    fileSystem,
    resolveDirectory: () => ARTIFACT_DIR,
  });
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
    installFake(fileSystem);

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

  test("reads artifacts when the configured directory ends in a separator", async () => {
    // resolvePathFromDaemonLaunchWorkingDirectory preserves a trailing slash on an
    // absolute --tool-outputs-dir; the read must still resolve (issue #5882 review).
    const fileSystem = new FakeResourceFileSystem();
    const trailingSlashDir = `${ARTIFACT_DIR}/`;
    const filename = "1788020656886-observe-abc123.json";
    const raw = JSON.stringify({ ok: true });
    fileSystem.files.set(path.join(trailingSlashDir, filename), raw);
    setToolOutputResourceDependencies({
      fileSystem,
      resolveDirectory: () => trailingSlashDir,
    });

    const content = await readArtifact(filename);

    expect(content.text).toBe(raw);
    expect(fileSystem.reads).toEqual([path.join(trailingSlashDir, filename)]);
  });

  test("refuses to follow a writer-shaped symlink to a file outside the directory", async () => {
    // Real filesystem: the node readFile impl must reject a symlink target even
    // when its name passes the allowlist, so a shared/writable --tool-outputs-dir
    // can't be used to read arbitrary host files (issue #5882 review).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "am-tool-output-symlink-"));
    const secretPath = path.join(tmpDir, "secret-outside.txt");
    fs.writeFileSync(secretPath, "TOP SECRET");
    const linkName = "1788020656886-observe-deadbeef.json";
    const artifactDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactDir);
    fs.symlinkSync(secretPath, path.join(artifactDir, linkName));

    // Only the directory is injected; the real node readFile (with O_NOFOLLOW) runs.
    setToolOutputResourceDependencies({ resolveDirectory: () => artifactDir });

    const content = await readArtifact(linkName);

    expect(content.text).not.toContain("TOP SECRET");
    expect(content.text).toContain("not available");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns a structured error when the artifact is missing or pruned", async () => {
    const fileSystem = new FakeResourceFileSystem();
    installFake(fileSystem);

    const content = await readArtifact("1788020656886-observe-gone.json");

    expect(content.mimeType).toBe("application/json");
    const parsed = JSON.parse(content.text!) as { error: string };
    expect(parsed.error).toContain("not available");
  });
});
