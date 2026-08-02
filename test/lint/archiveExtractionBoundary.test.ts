import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  directlyExtractsTar,
  EXCEPTIONS,
  findOffenders,
  sourceFiles,
} from "../../scripts/check-archive-extraction-boundary";

const ROOT = join(import.meta.dir, "..", "..");

describe("archive extraction boundary (issue #4065)", () => {
  // Whole-tree scan: reads the full `src` tree and AST-parses the files that name a launcher and
  // `tar`, so it is not a <100ms unit test — grant it far more than Bun's 5s default, matching the
  // sibling sdkmanager boundary. The real gate is the fast-validate `archive-extraction-boundary`
  // check (scripts/check-archive-extraction-boundary.ts); this test guards the same detector.
  test("only ArchiveExtractor directly runs tar extraction", async () => {
    // A silently-empty scan yields zero offenders and passes green while checking nothing.
    expect(sourceFiles(join(ROOT, "src")).length).toBeGreaterThan(100);
    const offenders = await findOffenders(ROOT);
    expect(offenders, offenders.join("\n")).toEqual([]);
  }, 30_000);

  test("detects argv-first tar extraction regardless of flag position or order", () => {
    expect(directlyExtractsTar('await executor.executeCommand("tar", ["-xzf", archivePath, "-C", dir]);')).toBe(true);
    expect(directlyExtractsTar('spawn("tar", ["-x", "-f", archivePath]);')).toBe(true);
    // Extract flag after a leading -C change-dir option.
    expect(directlyExtractsTar('spawn("tar", ["-C", dir, "-xzf", archivePath]);')).toBe(true);
    // Long-form --extract.
    expect(directlyExtractsTar('execFile("tar", ["--extract", "--file", archivePath]);')).toBe(true);
    // Verbose bundle containing x.
    expect(directlyExtractsTar('spawn("tar", ["-vxf", archivePath]);')).toBe(true);
  });

  test("detects shell-string tar extraction, including static concatenation", () => {
    expect(directlyExtractsTar('exec("tar -xzf archive.tar.gz -C dest");')).toBe(true);
    expect(directlyExtractsTar('exec("tar -C dest --extract -f archive.tar.gz");')).toBe(true);
    // Command assembled with a binary + expression; the static prefix still reads as tar extract.
    expect(directlyExtractsTar('executor.exec("tar -xzf " + archive);')).toBe(true);
    expect(directlyExtractsTar('const run = exec; run("tar -xzf archive.tar.gz -C dest");')).toBe(true);
    expect(directlyExtractsTar(
      'runExecSeam(cb, opts, { command: "tar", args: ["-xzf", archive] });'
    )).toBe(true);
    expect(directlyExtractsTar(
      'const seam = runExecSeam; seam(cb, opts, { command: "tar", args: ["-xzf", archive] });'
    )).toBe(true);
    expect(directlyExtractsTar(
      'const command = "tar"; const args = ["-xzf", archive]; runExecSeam(cb, opts, { command, args });'
    )).toBe(true);
    expect(directlyExtractsTar(
      'const command = "tar"; const args = ["-xzf", archive]; const context = { command, args }; runExecSeam(cb, opts, { ...context });'
    )).toBe(true);
    expect(directlyExtractsTar('runExecSeam(cb, opts, { command: "echo", args: ["tar", "-x"] });')).toBe(false);
    expect(directlyExtractsTar('exec(useTar ? "tar -xzf archive.tar.gz" : "unzip archive.zip");')).toBe(true);
    expect(directlyExtractsTar('exec(process.env.ARCHIVE_CMD ?? "tar -xzf archive.tar.gz");')).toBe(true);
    expect(directlyExtractsTar("exec(String.raw`tar -xzf archive.tar.gz`);")).toBe(true);
  });

  test("detects array-first tar extraction (Bun.spawn's single-array signature)", () => {
    expect(directlyExtractsTar('Bun.spawn(["tar", "-xzf", archivePath, "-C", dir]);')).toBe(true);
    expect(directlyExtractsTar('spawn(["tar", "-x", "-f", archivePath]);')).toBe(true);
    expect(directlyExtractsTar('Bun.spawn(["tar", "-C", dir, "--extract", "-f", archivePath]);')).toBe(true);
    expect(directlyExtractsTar('Bun.spawn(["tar", "-czf", archivePath, dir]);')).toBe(false);
  });

  test("follows const argv initializers and spreads (ordinary refactor forms)", () => {
    expect(directlyExtractsTar('const args = ["-xzf", archive]; spawn("tar", args);')).toBe(true);
    expect(directlyExtractsTar('const argv = ["tar", "-xzf", archive]; Bun.spawn(argv);')).toBe(true);
    expect(directlyExtractsTar('const args = ["-xzf", archive]; spawn("tar", [...args]);')).toBe(true);
    expect(directlyExtractsTar('const rest = ["-xzf", a]; Bun.spawn(["tar", ...rest]);')).toBe(true);
    expect(directlyExtractsTar('const run = exec; run("tar", ["-xzf", archive], { cwd: dir });')).toBe(true);
    expect(directlyExtractsTar('const prefix = dynamic; Bun.spawn([...prefix, "tar", "-xzf", archive]);')).toBe(false);
    expect(directlyExtractsTar('const args = ["-czf", archive]; spawn("tar", args);')).toBe(false);
    expect(directlyExtractsTar(
      'const command = "tar"; const args = ["-xzf", archive]; const run = executeCommand; run(command, args);'
    )).toBe(true);
  });

  test("over-detects a shadowed argv name (loud false CI failure beats a silent miss)", () => {
    // Two functions reuse `args`; keying bindings by spelling unions both, so the extract argv is
    // still seen even though a later create-argv shares the name.
    expect(directlyExtractsTar(
      'function a(){ const args = ["-xzf", x]; spawn("tar", args); }' +
      'function b(){ const args = ["-czf", y]; spawn("tar", args); }'
    )).toBe(true);
  });

  test("detects long-form --get and multiline argv", () => {
    expect(directlyExtractsTar('execFile("tar", ["--get", "--file", archive]);')).toBe(true);
    expect(directlyExtractsTar('spawn("tar", [\n  "-C", dir,\n  "-xzf",\n  archive\n]);')).toBe(true);
    expect(directlyExtractsTar("exec(`tar -xzf ${archive} -C ${dir}`);")).toBe(true);
  });

  test("does not flag tar creation, listing, or non-extract options", () => {
    expect(directlyExtractsTar('executeCommand("tar", ["-czf", archivePath, dir]);')).toBe(false);
    expect(directlyExtractsTar('spawn("tar", ["-czf", archive], { env: { MODE: "-x" } });')).toBe(false);
    expect(directlyExtractsTar('executeCommand("tar", ["-tzf", archivePath]);')).toBe(false);
    // `-C` change-dir on its own is not extraction.
    expect(directlyExtractsTar('executeCommand("tar", ["-C", dir]);')).toBe(false);
    // `--exclude` is a double-dash flag, not a single-dash extract bundle.
    expect(directlyExtractsTar('executeCommand("tar", ["--exclude", pattern, "-czf", archivePath]);')).toBe(false);
  });

  test("keeps the command position separate from its arguments", () => {
    // `tar` and `-x` are arguments to `echo`, not the command — not a tar extraction.
    expect(directlyExtractsTar('spawn("echo", ["tar", "-x"]);')).toBe(false);
    expect(directlyExtractsTar('Bun.spawn(["echo", "tar", "-x"]);')).toBe(false);
    // The prefilter must not classify incidental words like `start`/`target`.
    expect(directlyExtractsTar('await start(); const target = "-x"; log(target);')).toBe(false);
  });

  test("every documented exception still exists", () => {
    const present = new Set(sourceFiles(join(ROOT, "src")).map(file => file.replace(/\\/g, "/")));
    expect([...EXCEPTIONS.keys()].filter(path => ![...present].some(file => file.endsWith(`/${path}`)))).toEqual([]);
  });
});
