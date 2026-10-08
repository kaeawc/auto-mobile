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
    reason:
      "pid is a function argument or file-backed tracker of benchmark-owned children; global_timeout_pid comes from $!.",
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

export const STUB_FILES: Record<string, string> = {
  "test/bats/uninstall-desktop-app.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/uninstall-firebender-config.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/uninstall-remove-from-json-config.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/uninstall-stop-daemon.bats": "Recorded process-tool stubs in heredocs.",
  "test/bats/install-background-work.bats": "pgrep child-discovery stub in a heredoc.",
};

interface ShellWord {
  value: string;
  raw: string;
}
interface ShellCommand {
  words: ShellWord[];
  line: number;
  pipeline: object;
}

// A small source tokenizer, never an interpreter: quoted words remain words,
// quoted data remains data, but substitutions supply separate command positions.
function shellCommands(source: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let words: ShellWord[] = [];
  let value = "";
  let raw = "";
  let quote = "";
  let line = 1;
  let commandLine = 1;
  let pipeline: object = {};
  const flushWord = () => {
    if (raw) {
      words.push({ value, raw });
    }
    value = "";
    raw = "";
  };
  const flushCommand = () => {
    flushWord();
    if (words.length) {
      commands.push({ words, line: commandLine, pipeline });
    }
    words = [];
    commandLine = line;
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\\" && quote !== "'") {
      raw += char + (source[index + 1] ?? "");
      value += source[++index] ?? "";
    } else if (((char === "$" && source[index + 1] === "(") || char === "`") && quote !== "'") {
      const backtick = char === "`";
      const start = index + (backtick ? 1 : 2);
      let depth = 1;
      let innerQuote = "";
      let end = start;
      for (; end < source.length; end++) {
        const current = source[end];
        if (current === "\\") {
          end++;
          continue;
        }
        if ((current === '"' || current === "'") && (!innerQuote || innerQuote === current)) {
          innerQuote = innerQuote ? "" : current;
        } else if (!innerQuote) {
          if (backtick && current === "`") {
            break;
          }
          if (!backtick && current === "(") {
            depth++;
          }
          if (!backtick && current === ")" && --depth === 0) {
            break;
          }
        }
      }
      commands.push(
        ...shellCommands(source.slice(start, end)).map((command) => ({
          ...command,
          line: command.line + line - 1,
        })),
      );
      raw += source.slice(index, end + 1);
      value += source.slice(index, end + 1);
      line += source.slice(index, end + 1).split("\n").length - 1;
      index = end;
    } else if ((char === "'" || char === '"') && (!quote || quote === char)) {
      raw += char;
      quote = quote ? "" : char;
    } else if (!quote && char === "#" && !raw) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end - 1;
    } else if (!quote && ";|&(){}\n".includes(char)) {
      // ${var} is a word, whereas standalone braces delimit shell groups.
      if (char === "{" && raw.endsWith("$")) {
        const end = source.indexOf("}", index);
        const part = source.slice(index, end < 0 ? source.length : end + 1);
        raw += part;
        value += part;
        index += part.length - 1;
      } else {
        flushCommand();
        if (char !== "|" || source[index + 1] === "|" || source[index - 1] === "|") {
          pipeline = {};
        }
        if (char === "\n") {
          line++;
          commandLine = line;
        }
      }
    } else if (!quote && /\s/.test(char)) {
      flushWord();
    } else {
      raw += char;
      value += char;
    }
  }
  flushCommand();
  return commands;
}

// Heredoc bodies are data. The explicit stub-file registry explains the process
// fixtures; skipping all bodies also prevents Python/JSON/log text being commands.
function shellCode(source: string): string {
  let delimiter: string | undefined;
  return source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => {
      if (delimiter !== undefined) {
        if (line.trim() === delimiter) {
          delimiter = undefined;
        }
        return "";
      }
      const words = shellCommands(line).flatMap((command) => command.words);
      const heredoc = words.find((word) => /^<<-?/.test(word.raw));
      if (heredoc) {
        const index = words.indexOf(heredoc);
        delimiter = heredoc.value.replace(/^<<-?/, "") || words[index + 1]?.value;
      }
      return line;
    })
    .join("\n");
}

const assignments = /^[A-Za-z_][A-Za-z_0-9]*=/;
const variableName = /^\$(?:\{([A-Za-z_][A-Za-z_0-9]*)\}|([A-Za-z_][A-Za-z_0-9]*))$/;
function commandWords(words: ShellWord[]): ShellWord[] {
  let index = 0;
  while (index < words.length) {
    const value = words[index].value;
    const name = value.split("/").at(-1) ?? "";
    if (
      assignments.test(value) ||
      ["!", "if", "then", "do", "else", "elif", "run"].includes(name)
    ) {
      index++;
      continue;
    }
    if (name === "command" && words[index + 1]?.value === "-v") {
      return [];
    }
    if (["sudo", "time", "env"].includes(name) && words[index + 1]?.value === "--help") {
      return [];
    }
    if (
      !["env", "nohup", "timeout", "xargs", "sudo", "command", "exec", "time", "nice"].includes(
        name,
      )
    ) {
      break;
    }
    index++;
    while (
      index < words.length &&
      (words[index].value.startsWith("-") || assignments.test(words[index].value))
    ) {
      const option = words[index++].value;
      if (
        [
          "-n",
          "-u",
          "-g",
          "-h",
          "-p",
          "-C",
          "-S",
          "-t",
          "-k",
          "-s",
          "-I",
          "-L",
          "-d",
          "-a",
          "-f",
          "-o",
          "--signal",
          "--kill-after",
          "--adjustment",
          "--user",
          "--group",
          "--unset",
          "--chdir",
          "--max-args",
          "--max-lines",
          "--replace",
        ].includes(option) &&
        !option.includes("=") &&
        !(name === "command" && option === "-p") &&
        !(name === "sudo" && option === "-n") &&
        !(name === "xargs" && option === "-r")
      ) {
        index++;
      }
    }
    if (name === "timeout") {
      index++;
    }
  }
  return words.slice(index);
}

// -P grants scope only to this shell or a variable assigned from $!/$$ in the
// same script. No -f, additional selector, or name pattern is allowed. Function
// parameters/file-backed trackers need a documented, invocation-sized exception.
function parentScoped(args: string[], ownedVariables: Set<string>): boolean {
  const parent = args.indexOf("-P");
  const value = args[parent + 1];
  if (parent < 0 || !value) {
    return false;
  }
  const variable = value.match(variableName);
  return (
    (value === "$$" ||
      value === "$BASHPID" ||
      (!!variable && ownedVariables.has(variable[1] ?? variable[2]))) &&
    scopedArguments(args)
  );
}
function scopedArguments(args: string[]): boolean {
  const parent = args.indexOf("-P");
  if (parent < 0 || !args[parent + 1]) {
    return false;
  }
  return args.every(
    (arg, index) =>
      index === parent ||
      index === parent + 1 ||
      /^-(?:TERM|KILL|[0-9]+|\$\{?signal\}?)$/.test(arg) ||
      /^[012]?>/.test(arg),
  );
}

function uninstallStubs(source: string): boolean {
  const code = shellCode(source);
  const commands = shellCommands(code);
  const stubDirectories = new Map<string, Set<string>>();
  const pathDirectories = new Set<string>();
  const executableStubs = new Map<string, Set<string>>();
  let loopTools: string[] = [];
  let loopVariable = "";
  let setup = false;
  let depth = 0;
  let setupDepth = 0;
  let killFunction = false;
  let killExport = false;
  // Use line tokens for definitions/loop headers/redirections, and count braces
  // outside quotes to keep PATH evidence inside setup().
  for (const line of code.split("\n")) {
    const tokens = shellCommands(line)
      .flatMap((command) => command.words)
      .map((word) => word.value);
    if (tokens[0] === "setup" && /\(\)\s*\{/.test(line)) {
      setup = true;
      setupDepth = depth;
    }
    if (setup) {
      for (const token of tokens) {
        const prepend = token.match(/^PATH=(\$\{?[A-Za-z_][A-Za-z_0-9]*\}?):\$\{?PATH\}?$/);
        if (prepend) {
          pathDirectories.add(prepend[1].replace(/[{}]/g, ""));
        }
      }
    }
    if (tokens[0] === "for" && tokens[2] === "in") {
      loopVariable = tokens[1];
      loopTools = tokens
        .slice(3)
        .filter((token) => ["pkill", "killall", "pgrep", "ps", "kill"].includes(token));
    }
    // Only executable modes can stand in for host process tools. Evidence is
    // keyed by the exact destination, including a loop's expanded tool names.
    const chmodMode = tokens[0] === "chmod" ? tokens[1] : undefined;
    const installModeIndex = tokens[0] === "install" ? tokens.indexOf("-m") : -1;
    const mode = chmodMode ?? (installModeIndex >= 0 ? tokens[installModeIndex + 1] : undefined);
    const executableMode =
      !!mode &&
      (/^(?:[0-7]{3,4})$/.test(mode)
        ? (Number.parseInt(mode, 8) & 0o100) !== 0
        : /^(?:[au]*\+[rwx]*x[rwx]*)$/.test(mode));
    if (mode !== undefined) {
      const destinations = tokens[0] === "chmod" ? tokens.slice(2) : tokens.slice(-1);
      for (const destination of destinations) {
        const directory = destination.slice(0, destination.lastIndexOf("/")).replace(/[{}]/g, "");
        const basename = destination.split("/").at(-1);
        const tools = executableStubs.get(directory) ?? new Set<string>();
        executableStubs.set(directory, tools);
        if (basename === `$${loopVariable}` || basename === `\${${loopVariable}}`) {
          for (const tool of loopTools) {
            if (executableMode) {
              tools.add(tool);
            } else {
              tools.delete(tool);
            }
          }
        } else if (basename) {
          if (executableMode) {
            tools.add(basename);
          } else {
            tools.delete(basename);
          }
        }
      }
    }
    if (["cat", "printf", "install"].includes(tokens[0])) {
      for (const [index, token] of tokens.entries()) {
        const destination =
          tokens[0] === "install" && index === tokens.length - 1
            ? token
            : token === ">"
              ? tokens[index + 1]
              : token.startsWith(">")
                ? token.slice(1)
                : undefined;
        if (!destination) {
          continue;
        }
        const basename = destination.split("/").at(-1);
        const directory = destination.slice(0, destination.lastIndexOf("/")).replace(/[{}]/g, "");
        const tools = stubDirectories.get(directory) ?? new Set<string>();
        stubDirectories.set(directory, tools);
        if (basename && ["pkill", "killall", "pgrep", "ps", "kill"].includes(basename)) {
          tools.add(basename);
        }
        if (basename === `$${loopVariable}` || basename === `\${${loopVariable}}`) {
          for (const tool of loopTools) {
            tools.add(tool);
          }
        }
      }
    }
    if (tokens[0] === "kill" && /\(\)\s*\{/.test(line)) {
      killFunction = true;
    }
    if (tokens[0] === "export" && tokens.includes("-f") && tokens.includes("kill")) {
      killExport = true;
    }
    // Tokenizer treats braces in variables/quoted words as data.
    const braceCode = line.replace(/\$\{[^}]*\}|"[^"]*"|'[^']*'|#.*/g, "");
    depth += (braceCode.match(/\{/g)?.length ?? 0) - (braceCode.match(/\}/g)?.length ?? 0);
    if (setup && depth <= setupDepth) {
      setup = false;
    }
  }
  return (
    commands.length > 0 &&
    [...stubDirectories].some(
      ([directory, tools]) =>
        pathDirectories.has(directory) &&
        ["pkill", "killall", "pgrep", "ps", "kill"].every(
          (tool) =>
            (tools.has(tool) && executableStubs.get(directory)?.has(tool)) ||
            (tool === "kill" && killFunction && killExport),
        ),
    )
  );
}

function invokesUninstall(commands: ShellCommand[]): boolean {
  const scriptPattern = /(?:^|\/)(?:clean-env-)?uninstall\.sh$/;
  const variables = new Set<string>();
  for (const command of commands) {
    for (const word of command.words) {
      if (["local", "export", "declare", "readonly"].includes(word.value)) {
        continue;
      }
      if (!assignments.test(word.value)) {
        break;
      }
      if (scriptPattern.test(word.value.slice(word.value.indexOf("=") + 1))) {
        variables.add(word.value.split("=")[0]);
      }
    }
  }
  return commands.some((command) => {
    const words = commandWords(command.words);
    const tool = words[0]?.value.split("/").at(-1) ?? "";
    const isScript = (word: ShellWord): boolean => {
      const variable = word.value.match(variableName);
      return (
        scriptPattern.test(word.value) || (!!variable && variables.has(variable[1] ?? variable[2]))
      );
    };
    return (
      !!words[0] &&
      (isScript(words[0]) ||
        (["source", ".", "bash", "sh", "zsh"].includes(tool) && words.slice(1).some(isScript)))
    );
  });
}

export function checkProcessSafetySource(
  file: string,
  source: string,
  loadedHelpers: readonly string[] = [],
): ProcessSafetyViolation[] {
  if (FIXTURE_FILES[file]) {
    return [];
  }
  const violations: ProcessSafetyViolation[] = [];
  const code = shellCode(source);
  const commands = shellCommands(code);
  const ownedVariables = new Set<string>();
  const literalCommands = new Map<string, string>();
  for (const command of commands) {
    for (const word of command.words) {
      if (["local", "export", "declare", "readonly"].includes(word.value)) {
        continue;
      }
      if (!assignments.test(word.value)) {
        break;
      }
      const [variable, ...parts] = word.value.split("=");
      const value = parts.join("=");
      if (["$!", "$$"].includes(value)) {
        ownedVariables.add(variable);
      }
      if (["pkill", "killall"].includes(value)) {
        literalCommands.set(variable, value);
      }
    }
  }
  const discoveries = new Set<object>();
  const psPipelines = new Set<object>();
  const selectionPipelines = new Set<object>();
  const signallingCommands: ShellCommand[] = [];
  for (const command of commands) {
    const words = commandWords(command.words);
    if (!words.length) {
      continue;
    }
    const variable = words[0].value.match(variableName);
    const tool =
      (variable
        ? literalCommands.get(variable[1] ?? variable[2])
        : words[0].value.split("/").at(-1)) ?? "";
    const args = words.slice(1).map((word) => word.value);
    const original = words.map((word) => word.raw).join(" ");
    // A definition creates a function; it does not invoke the process tool.
    if (
      ["pkill", "killall", "pgrep", "kill"].includes(tool) &&
      !args.length &&
      new RegExp(`^\\s*${tool}\\(\\)`).test(code.split("\n")[command.line - 1] ?? "")
    ) {
      continue;
    }
    const approved = PROCESS_SAFETY_ALLOWLIST[file]?.pattern.test(original) ?? false;
    if (["bash", "sh", "zsh"].includes(tool) && args.includes("-c")) {
      const payload = args[args.indexOf("-c") + 1];
      if (payload) {
        violations.push(
          ...checkProcessSafetySource("scripts/embedded-shell", payload).map((violation) => ({
            ...violation,
            file,
            line: command.line,
          })),
        );
      }
    }
    if (tool === "pkill" || tool === "killall") {
      if (
        !(
          tool === "pkill" &&
          (parentScoped(args, ownedVariables) || (approved && scopedArguments(args)))
        )
      ) {
        violations.push({ file, line: command.line, reason: `Unscoped ${tool} invocation` });
      }
    }
    if (tool === "pgrep" && !approved && !parentScoped(args, ownedVariables)) {
      discoveries.add(command.pipeline);
    }
    if (tool === "ps") {
      psPipelines.add(command.pipeline);
    }
    if (["grep", "awk"].includes(tool)) {
      selectionPipelines.add(command.pipeline);
    }
    if (tool === "kill" && args[0] !== "-0") {
      signallingCommands.push(command);
    }
  }
  for (const pipeline of psPipelines) {
    if (selectionPipelines.has(pipeline)) {
      discoveries.add(pipeline);
    }
  }
  // Pipe inputs flow directly to xargs kill. Substitution/assignment words retain
  // their source so discovery can flow through a PID variable on later lines.
  const containsDiscovery = (text: string): boolean => {
    const nested = shellCommands(text);
    return nested.some((command) => {
      const words = commandWords(command.words);
      const tool = words[0]?.value.split("/").at(-1);
      const approved = PROCESS_SAFETY_ALLOWLIST[file]?.pattern.test(
        words.map((word) => word.raw).join(" "),
      );
      if (tool === "pgrep") {
        return (
          !approved &&
          !parentScoped(
            words.slice(1).map((word) => word.value),
            ownedVariables,
          )
        );
      }
      return (
        tool === "ps" &&
        nested.some(
          (selection) =>
            selection.pipeline === command.pipeline &&
            ["grep", "awk"].includes(commandWords(selection.words)[0]?.value ?? ""),
        )
      );
    });
  };
  const selectedVariables = new Set<string>();
  for (const command of commands) {
    for (const word of command.words) {
      if (["local", "export", "declare", "readonly"].includes(word.value)) {
        continue;
      }
      if (!assignments.test(word.value)) {
        break;
      }
      if (containsDiscovery(word.value)) {
        selectedVariables.add(word.value.split("=")[0]);
      }
    }
  }
  // Semicolons end pipelines but not loop input flow. Keep compound scopes
  // until done, so unsafe discovery feeding read/iteration taints signals in
  // that body without treating literal or verified-record loops as discovery.
  const compoundScopes: boolean[] = [];
  const unsafeCompoundSignals = new Set<ShellCommand>();
  for (const command of commands) {
    const words = commandWords(command.words);
    const tool = words[0]?.value;
    if (tool === "done") {
      compoundScopes.pop();
      continue;
    }
    if (tool === "for" || tool === "while" || tool === "until") {
      compoundScopes.push(
        discoveries.has(command.pipeline) ||
          words.some(
            (word) =>
              containsDiscovery(word.raw) ||
              [...selectedVariables].some((variable) =>
                new RegExp(`\\$\\{?${variable}(?:\\}|\\b)`).test(word.value),
              ),
          ),
      );
    }
    if (compoundScopes.includes(true) && signallingCommands.includes(command)) {
      unsafeCompoundSignals.add(command);
    }
  }
  const consumesDiscovery = signallingCommands.some(
    (signal) =>
      unsafeCompoundSignals.has(signal) ||
      discoveries.has(signal.pipeline) ||
      commands
        .filter((command) => command.pipeline === signal.pipeline)
        .some((command) =>
          command.words.some(
            (word) =>
              containsDiscovery(word.raw) ||
              [...selectedVariables].some((variable) =>
                new RegExp(`\\$\\{?${variable}(?:\\}|\\b)`).test(word.value),
              ),
          ),
        ),
  );
  if (consumesDiscovery) {
    violations.push({ file, line: 1, reason: "kill may consume pattern-based pgrep or ps output" });
  }
  if (
    file.startsWith("test/bats/") &&
    file.endsWith(".bats") &&
    invokesUninstall(commands) &&
    !uninstallStubs([source, ...loadedHelpers].join("\n"))
  ) {
    violations.push({
      file,
      line: 1,
      reason: "Uninstall test lacks executable process stubs or setup PATH prepend",
    });
  }
  return violations;
}

// Untracked tool environments (e.g. scripts/github/.venv, which the parallel
// github-python-lock fast check rewrites with `uv sync`) are not repository
// sources; walking them races that rewrite and fails with ENOENT.
const SKIPPED_DIRECTORIES = new Set([".venv", "node_modules", "__pycache__"]);

export function candidateFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : candidateFiles(file);
    }
    return [file];
  });
}

export function checkProcessSafetyAllowlist(
  sources: ReadonlyMap<string, string>,
): ProcessSafetyViolation[] {
  return Object.entries(PROCESS_SAFETY_ALLOWLIST).flatMap(([file, entry]) =>
    shellCode(sources.get(file) ?? "")
      .split("\n")
      .some((line) =>
        shellCommands(line).some((command) => {
          const words = commandWords(command.words);
          return (
            ["pkill", "pgrep", "killall"].includes(words[0]?.value ?? "") &&
            entry.pattern.test(words.map((word) => word.raw).join(" "))
          );
        }),
      )
      ? []
      : [{ file, line: 1, reason: `Stale process-safety allowlist: ${entry.reason}` }],
  );
}

export function checkProcessSafetyTree(root: string = "."): ProcessSafetyViolation[] {
  const sources = new Map<string, string>();
  const violations = ["scripts", "test/bats"].flatMap((directory) =>
    candidateFiles(join(root, directory)).flatMap((path) => {
      const file = path.slice(root === "." ? 0 : root.length + 1).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      sources.set(file, source);
      if (!/\b(?:pkill|killall|pgrep|kill|ps)\b|uninstall\.sh/.test(source)) {
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
  return [...violations, ...checkProcessSafetyAllowlist(sources)];
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
