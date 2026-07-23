import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/ios/IOSCtrlProxyProcessClient.ts";
const EXCEPTIONS = new Map<string, string>();
const FORBIDDEN = /(?:\.(?:exec|executeCommand)\s*\(\s*["'`])(?:ps|pgrep|kill)(?:\s|["'`])/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

const offenders = sourceFiles(SOURCE_ROOT).flatMap(file => {
  const repoPath = relative(".", file);
  if (repoPath === OWNER || EXCEPTIONS.has(repoPath)) {return [];}
  return FORBIDDEN.test(readFileSync(file, "utf8"))
    ? [`${repoPath} directly executes CtrlProxy PID tooling; route it through ${OWNER}.`]
    : [];
});

if (offenders.length > 0) {
  console.error(offenders.join("\n"));
  process.exit(1);
}

console.log("ios-ctrl-proxy-process-boundary: no direct production PID tooling.");
