import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProcessSafetyViolation {
  file: string;
  line: number;
  reason: string;
}

// Exceptions describe specific operations, never a blanket file exemption.
export const PROCESS_SAFETY_ALLOWLIST: Record<string, { reason: string; pattern: RegExp }> = {
  "scripts/benchmark-startup.sh": {
    reason: "pkill -P is scoped to the benchmark's own children.",
    pattern:
      /\bpkill\s+(?:"-\$signal"\s+|-TERM\s+|-KILL\s+)?-P\s+(?:"\$(?:pid|global_timeout_pid)"|\$\$)/,
  },
  "scripts/install.sh": {
    reason: "pgrep -P enumerates only installer-owned children.",
    pattern: /\bpgrep -P "\$\{pid\}"/,
  },
  "scripts/local-dev/hot-reload.sh": {
    reason: "Existing singleton discovery of this watcher; deliberately retained for #9056.",
    pattern: /\bpgrep -f "hot-reload\.sh"/,
  },
  "scripts/local-dev/lib/ide-plugin.sh": {
    reason: "Desktop orphan cleanup uses an ERE-escaped absolute checkout path.",
    pattern: /\bpgrep -f "(?:\$\{android_re\}|compose\\\\\.reload\\\\\.argfile=\$\{android_re\})/,
  },
  "scripts/test-ctrl-proxy-ios.sh": {
    reason: "CtrlProxy detection only; the discovered PID is never signalled.",
    pattern: /\bpgrep -f 'xcodebuild\.\*CtrlProxy'/,
  },
};

const FIXTURE_FILES: Record<string, string> = {
  "scripts/check-process-safety.ts":
    "The guard's own TypeScript regex definitions, not shell commands.",
};

const STUB_FILES: Record<string, string> = {
  "test/bats/uninstall-desktop-app.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/uninstall-firebender-config.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/uninstall-remove-from-json-config.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/uninstall-stop-daemon.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/install-background-work.bats": "pgrep child-discovery stub in a heredoc.",
};

function hasPkillStub(source: string): boolean {
  return (
    /(?:cat|printf)\s[^\n]*>[^\n]*\/pkill["']?[^\n]*(?:<<|$)/m.test(source) ||
    (/for tool in pkill killall pgrep;/.test(source) &&
      /cat > "\$\{STUB_BIN\}\/\$\{tool\}" <<'STUB'/.test(source)) ||
    /^\s*pkill\(\)\s*\{/m.test(source)
  );
}

// Hide quoted data so grep assertions and logged text are not commands.
// Keep command substitutions in double quotes visible to the command scanner.
function shellCommandText(line: string): string {
  let quote = "";
  let result = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\\" && quote !== "'") {
      result += "  ";
      index++;
    } else if (quote === "" && char === "#") {
      break;
    } else if ((char === "'" || char === '\"') && (quote === "" || quote === char)) {
      quote = quote === char ? "" : char;
      result += " ";
    } else if (quote === '\"' && char === "$" && line[index + 1] === "(") {
      const end = line.indexOf(")", index + 2);
      if (end < 0) {
        return result + line.slice(index);
      }
      result += "$(" + shellCommandText(line.slice(index + 2, end)) + ")";
      index = end;
    } else {
      result += quote ? " " : char;
    }
  }
  return result;
}

// This is a conservative shell source guard, not a shell interpreter. Join
// continuations and inspect command positions, avoiding comments/grep fixtures.
export function checkProcessSafetySource(
  file: string,
  source: string,
  loadedHelpers: readonly string[] = [],
): ProcessSafetyViolation[] {
  // The checker itself contains regex/fixture syntax, not shell invocations.
  // Keep this explicit exception keyed by file with its reason.
  if (FIXTURE_FILES[file]) {
    return [];
  }
  const violations: ProcessSafetyViolation[] = [];
  const lines = source.replace(/\\\n/g, " ").split("\n");
  const code = lines.filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const command =
    /(?:^|[;|&({]|\$\(|`|\b(?:if|then|do)\s+)\s*(?:!\s+)?(?:(?:sudo|command|exec|run)\s+)?(?:\/[^\s]+\/)?(pkill|killall|pgrep)\b([^\n;|&`]*)/g;
  let unsafeDiscovery = false;
  let heredoc: string | undefined;
  for (const [index, line] of lines.entries()) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) {
        heredoc = undefined;
      }
      continue;
    }
    const stub = line.match(
      /(?:cat|printf).*\/\$?\{?(?:tool|pgrep|pkill|killall)\}?"?\s*<<\s*['"]?(\w+)/,
    );
    if (stub && STUB_FILES[file]) {
      heredoc = stub[1];
      continue;
    }
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    // Shell -c payloads are commands, unlike ordinary quoted log/grep data.
    for (const payload of line.matchAll(
      /(?:^|[;|&])\s*(?:run\s+)?(?:bash|sh|zsh)\s+-c\s+(["'])(.*?)\1/g,
    )) {
      violations.push(
        ...checkProcessSafetySource("scripts/embedded-shell", payload[2]).map((violation) => ({
          ...violation,
          file,
          line: index + 1,
        })),
      );
    }
    const commands = shellCommandText(line).replace(/^\s*(?:pkill|killall|pgrep)\(\)\s*\{/, "");
    command.lastIndex = 0;
    for (const match of commands.matchAll(command)) {
      const tool = match[1];
      const original = line.slice(match.index ?? 0, (match.index ?? 0) + match[0].length);
      const args = original.slice(match[0].indexOf(tool) + tool.length);
      if (PROCESS_SAFETY_ALLOWLIST[file]?.pattern.test(original)) {
        continue;
      }
      if (tool === "pgrep") {
        if (!/(?:^|\s)-P\s+\S+/.test(args)) {
          unsafeDiscovery = true;
        }
      } else if (tool === "killall" || !/(?:^|\s)-P\s+(?![;|&])\S+/.test(args)) {
        violations.push({ file, line: index + 1, reason: `Unscoped ${tool} invocation` });
      }
    }
  }
  // A newly introduced pattern discovery beside a signalling path is unsafe.
  // Detection-only pgrep remains legal. Known project/singleton cases above
  // exempt only their approved discovery line, so a new daemon pattern fails.
  if (unsafeDiscovery && /\b(?:xargs\s+(?:-\S+\s+)*kill|kill\s+(?!-0\b))/.test(code)) {
    violations.push({ file, line: 1, reason: "kill may consume pattern-based pgrep output" });
  }
  if (
    file.startsWith("test/bats/") &&
    file.endsWith(".bats") &&
    /(?:clean-env-)?uninstall\.sh/.test(code) &&
    ![source, ...loadedHelpers].some(hasPkillStub)
  ) {
    violations.push({ file, line: 1, reason: "Uninstall test lacks a pkill stub" });
  }
  return violations;
}

function candidateFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? candidateFiles(file) : [file];
  });
}

export function checkProcessSafetyTree(root: string = "."): ProcessSafetyViolation[] {
  return ["scripts", "test/bats"].flatMap((directory) =>
    candidateFiles(join(root, directory)).flatMap((path) => {
      const file = path.slice(root === "." ? 0 : root.length + 1).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      if (!/\b(?:pkill|killall|pgrep)\b|uninstall\.sh/.test(source)) {
        return [];
      }
      const helpers = [...source.matchAll(/^\s*(?:load|source)\s+["']([^"']+)["']/gm)]
        .map((match) => match[1].replaceAll("${BATS_TEST_DIRNAME}", dirname(resolve(path))))
        .filter((helper) => !helper.includes("$") && !helper.endsWith("uninstall.sh"))
        .map((helper) => {
          const helperPath = resolve(dirname(path), helper);
          return readFileSync(helperPath, "utf8");
        });
      return checkProcessSafetySource(file, source, helpers);
    }),
  );
}

if (import.meta.main) {
  const violations = checkProcessSafetyTree();
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.reason}`);
  }
  if (violations.length > 0) {
    process.exit(1);
  }
  console.log("process-safety: no unscoped pattern kills; uninstall tests have process stubs.");
}
