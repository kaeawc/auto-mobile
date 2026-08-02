import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { executionBoundaryAst } from "./lib/executionBoundaryAst";

// The single home of the archive-extraction boundary guard (issue #4065). Both the fast-validate
// check and test/lint/archiveExtractionBoundary.test.ts import `directlyExtractsTar` from here so
// there is exactly one detector. It parses TypeScript structurally (AGENTS.md: no line regexes for
// TS) and reports a launcher call whose *command position* is `tar` together with an extract flag,
// whether written as a shell string, argv-first, array-first, via `const` argv, a spread, or a
// static string concatenation.
export const SOURCE_ROOT = "src";
export const OWNER = "src/utils/ArchiveExtractor.ts";
// Files allowed to run tar extraction outside the owner, each with a concrete reason. Keep empty
// unless a production diagnostic genuinely cannot use the owner.
export const EXCEPTIONS = new Map<string, string>();

const LAUNCHER_NAMES = new Set([
  "spawn",
  "spawnSync",
  "spawnCommand",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "executeCommand",
  "runExecSeam",
]);

// An extract flag token: `--extract`/`--get`, or a single-dash bundle containing `x` (`-x`, `-xf`,
// `-xzf`, `-vxf`, …). Deliberately NOT create/list bundles (`-c…`, `-t…`, no `x`), the uppercase
// `-C` change-dir option, or `--exclude`.
const EXTRACT_FLAG = /^(?:--extract|--get|-[a-z]*x[a-z]*)$/i;
// Shell-string form: one command string that is the whole `tar … <extract-flag> …` line.
const SHELL_TAR_EXTRACT = /(?:^|\s)tar\s+[\s\S]*?(?:--extract|--get|-[a-z]*x[a-z]*)(?:\s|$)/i;

export function directlyExtractsTar(source: string): boolean {
  // Narrow prefilter (keeps the whole-tree scan cheap): the file must both name a launcher and
  // mention `tar` as a whole word — this skips incidental substrings like `start`/`target`.
  if (!/\btar\b/i.test(source)) {return false;}
  if (![...LAUNCHER_NAMES].some(name => source.includes(name))) {return false;}

  const sharedAst = executionBoundaryAst(source);
  return sharedAst.calls.some(call => {
    if (!sharedAst.isLauncher(call) && !sharedAst.isExecutionSeam(call)) {return false;}
    if (sharedAst.isRunExecSeam(call)) {
      const command = sharedAst.objectPropertyValues(call.arguments[2], "command");
      const args = sharedAst.objectPropertyValues(call.arguments[2], "args");
      return command.some(value => sharedAst.strings(value).includes("tar")) &&
        args.some(value => sharedAst.strings(value).some(flag => EXTRACT_FLAG.test(flag)));
    }
    const alternatives = sharedAst.arrayAlternatives(call.arguments[0]) ?? [[call.arguments[0]]];
    return alternatives.some(([command, ...args]) => {
      if (sharedAst.strings(command).some(value => SHELL_TAR_EXTRACT.test(value))) {return true;}
      const argvAlternatives = args.length > 0 ? [args] : sharedAst.arrayAlternatives(call.arguments[1]) ?? [];
      return sharedAst.strings(command).includes("tar") && argvAlternatives.some(argv =>
        argv.some(argument => sharedAst.strings(argument).some(value => EXTRACT_FLAG.test(value))));
    });
  });
}

export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Scan `<root>/src` for files that run tar extraction outside the owner. Returns one message per
 * offender; an empty array means the boundary holds. Files are read in parallel so the whole-tree
 * scan stays fast enough for a bun test running under coverage instrumentation.
 */
export async function findOffenders(root: string): Promise<string[]> {
  const sources = await Promise.all(sourceFiles(join(root, SOURCE_ROOT)).map(async file => ({
    // `relative` yields OS separators (backslashes on Windows); OWNER/EXCEPTIONS are keyed with
    // forward slashes, so normalize for the owner exclusion and portable messages.
    repoPath: relative(root, file).replace(/\\/g, "/"),
    source: await readFile(file, "utf8"),
  })));
  return sources.flatMap(({ repoPath, source }) =>
    repoPath !== OWNER && !EXCEPTIONS.has(repoPath) && directlyExtractsTar(source)
      ? [`${repoPath} directly runs tar extraction; route it through ${OWNER} instead.`]
      : []);
}

if (import.meta.main) {
  const root = process.cwd();
  const files = sourceFiles(join(root, SOURCE_ROOT));
  // A silently-empty scan yields zero offenders and passes green while checking nothing.
  if (files.length < 100) {
    console.error(`error: archive-extraction-boundary scanned only ${files.length} files under ${SOURCE_ROOT}; expected the full source tree.`);
    process.exit(1);
  }
  const offenders = await findOffenders(root);
  if (offenders.length > 0) {
    console.error(`error: tar extraction must use ${OWNER}:`);
    for (const offender of offenders) {console.error(offender);}
    process.exit(1);
  }
  console.log("archive-extraction-boundary: no direct production tar extraction.");
}
