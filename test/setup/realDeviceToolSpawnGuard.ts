/** Unit-only process boundary. No I/O or process access: the preload supplies both. */
const BLOCKED_TOOLS = new Set([
  "adb",
  "xcrun",
  "xcodebuild",
  "simctl",
  "devicectl",
  "emulator",
  "avdmanager",
  "sdkmanager",
  "ffmpeg",
  "curl",
]);
const GUARD_MARKER = Symbol("realDeviceToolSpawnGuard");
type SpawnFunction = (...args: never[]) => unknown;

export interface SpawnTarget {
  spawn: SpawnFunction;
  spawnSync: SpawnFunction;
}

export interface Violation {
  testFile: string;
  tool: string;
  argv: readonly string[];
  testScope?: object;
}

export interface SpawnGuardDependencies {
  target: SpawnTarget;
  testFile: string;
  getTestFile?: () => string;
  getTestScope?: (testFile: string) => object | undefined;
  onViolation?: (violation: Violation) => void;
  loadAllowList: () => ReadonlySet<string>;
  mode: "enforce" | "census";
  record?: (tool: string, argv: readonly string[], testFile: string) => void;
  report: Violation[];
}

export function isUnitTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.endsWith(".test.ts") &&
    !normalized.endsWith(".integration.test.ts") &&
    !normalized.startsWith("test/stress/") &&
    !normalized.includes("/test/stress/")
  );
}

/** Prefer retained caller frames over the runner's current file for late async work. */
export function testFileFromStack(stack: string | undefined): string | undefined {
  for (const match of stack?.matchAll(/\((.+\.test\.ts):\d+:\d+\)/g) ?? []) {
    return match[1].replaceAll("\\", "/");
  }
  return undefined;
}

function executableName(value: string): string {
  return (value.replaceAll("\\", "/").split("/").pop() ?? "").replace(/\.(exe|cmd|bat)$/i, "");
}

// A bounded tokenizer, not a shell interpreter. The conservative pass ignores
// quote grouping and splits substitution delimiters to find exact tool tokens.
function tokenizeShellCommand(command: string, conservative = false) {
  const segments: string[][] = [[]];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let reliable = true;
  const finishWord = () => {
    if (started) {
      segments[segments.length - 1].push(word);
      word = "";
      started = false;
    }
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "\\" && quote !== "'") {
      if (next === undefined) {
        reliable = false;
      } else if (!quote || conservative || '$`"\\\n'.includes(next)) {
        index++;
        if (next !== "\n") {
          word += next;
          started = true;
        }
        continue;
      }
    }
    if (conservative && "'\"$()`".includes(char)) {
      finishWord();
    } else if (char === quote) {
      quote = undefined;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      started = true;
    } else if ((!quote || conservative) && /\s/.test(char)) {
      finishWord();
      if (char === "\n") {
        segments.push([]);
      }
    } else if ((!quote || conservative) && ";&|()".includes(char)) {
      finishWord();
      segments.push([]);
    } else {
      if (quote !== "'" && (char === "`" || (char === "$" && next === "("))) {
        reliable = false;
      }
      word += char;
      started = true;
    }
  }
  finishWord();
  return { segments, reliable: reliable && quote === undefined };
}

// Bounded unwrapping: sh/bash/zsh/dash -c, cmd /c, which/where lookups,
// env, exec, command, timeout, nice, nohup, and leading NAME=VALUE assignments.
// stdbuf, setsid, sudo, shell functions and other wrappers are not unwrapped.
// Substitutions use a conservative token scan. xcrun is blocked directly.
function isAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z_0-9]*=/.test(value);
}

function blockedEnv(argv: readonly string[]): string | undefined {
  let index = 1;
  while (index < argv.length) {
    const option = argv[index];
    if (option === "--") {
      index++;
      break;
    }
    // A value-taking letter ends a short cluster: subsequent letters are its
    // operand, not flags (e.g. -uS unsets S, while -iSadb splits adb).
    const operandIndex =
      option.startsWith("-") && !option.startsWith("--") ? option.slice(1).search(/[SuCa]/) + 1 : 0;
    const splitIndex = operandIndex > 0 && option[operandIndex] === "S" ? operandIndex : 0;
    if (splitIndex || option === "--split-string" || option.startsWith("--split-string=")) {
      const attached = splitIndex
        ? option.slice(splitIndex + 1)
        : option.slice("--split-string".length).replace(/^=/, "");
      const separate = splitIndex ? splitIndex === option.length - 1 : option === "--split-string";
      const value = separate ? (argv[index + 1] ?? "") : attached;
      const rest = argv.slice(index + (separate ? 2 : 1));
      // Split strings can reintroduce env options. Conservatively block any
      // guarded executable word, even when it is behind those options.
      const words = tokenizeShellCommand(value).segments.flat();
      return (
        blockedShellCommand(value) ??
        blockedLookup(words) ??
        blockedToolForArgv([...words, ...rest])
      );
    }
    if (option.startsWith("--")) {
      // Signal operands are optional and only accepted with '='. Other long
      // options without an operand still precede the command.
      index += ["--unset", "--chdir", "--argv0"].includes(option) ? 2 : 1;
    } else if (option.startsWith("-")) {
      // The first value-taking letter consumes the cluster remainder, or the
      // following token when it is the final letter in the cluster.
      index += operandIndex === option.length - 1 && operandIndex > 0 ? 2 : 1;
    } else {
      break;
    }
  }
  while (isAssignment(argv[index] ?? "")) {
    index++;
  }
  return blockedToolForArgv(argv.slice(index));
}

function blockedExec(argv: readonly string[]): string | undefined {
  let index = 1;
  while (index < argv.length && argv[index].startsWith("-")) {
    const option = argv[index++];
    if (option === "--") {
      break;
    }
    if (!/^-([cl]*a.*|[cl]+)$/.test(option)) {
      return undefined;
    }
    // -a consumes the rest of its cluster, or the following argv operand.
    if (/^-([cl]*a)$/.test(option)) {
      index++;
    }
  }
  return blockedToolForArgv(argv.slice(index));
}

function blockedCommand(argv: readonly string[]): string | undefined {
  let index = 1;
  let lookup = false;
  while (index < argv.length && argv[index].startsWith("-")) {
    const option = argv[index++];
    if (option === "--") {
      break;
    }
    if (!/^-[pvV]+$/.test(option)) {
      return undefined;
    }
    lookup ||= /[vV]/.test(option);
  }
  return lookup ? blockedLookup(argv.slice(index)) : blockedToolForArgv(argv.slice(index));
}

function blockedLookup(argv: readonly string[]): string | undefined {
  return argv.map(executableName).find((tool) => BLOCKED_TOOLS.has(tool));
}

function blockedTimeout(argv: readonly string[]): string | undefined {
  let index = 1;
  while (index < argv.length && argv[index].startsWith("-")) {
    const option = argv[index++];
    if (option === "--") {
      break;
    }
    if (["-s", "--signal", "-k", "--kill-after"].includes(option)) {
      index++;
    } else if (
      !/^(-[sk].|--(signal|kill-after)=)/.test(option) &&
      !["--foreground", "--preserve-status", "--verbose", "-v"].includes(option)
    ) {
      return undefined;
    }
  }
  // The next argument is the duration, even when it resembles a tool name.
  return blockedToolForArgv(argv.slice(index + 1));
}

function blockedNice(argv: readonly string[]): string | undefined {
  let index = 1;
  while (index < argv.length && argv[index].startsWith("-")) {
    const option = argv[index++];
    if (option === "--") {
      break;
    }
    if (["-n", "--adjustment"].includes(option)) {
      index++;
    } else if (!/^(-n.+|-\d+|--adjustment=.+)$/.test(option)) {
      return undefined;
    }
  }
  return blockedToolForArgv(argv.slice(index));
}

function blockedShellArgv(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--" || !/^[-+]/.test(option)) {
      return undefined;
    }
    if (["-o", "-O", "+o", "+O"].includes(option)) {
      index++;
    } else if (/^-[a-z]*c[a-z]*$/.test(option)) {
      return blockedShellCommand(argv[index + 1] ?? "");
    }
  }
  return undefined;
}

export function blockedToolForArgv(argv: readonly string[]): string | undefined {
  const name = executableName(argv[0] ?? "");
  if (BLOCKED_TOOLS.has(name)) {
    return name;
  }
  if (["sh", "bash", "zsh", "dash"].includes(name)) {
    return blockedShellArgv(argv);
  }
  if (name === "cmd") {
    const flag = argv.findIndex((arg) => ["/c", "/k"].includes(arg.toLowerCase()));
    if (flag < 0) {
      return undefined;
    }
    const command = argv.slice(flag + 1).join(" ");
    // cmd /s removes exactly the outer quote pair around its command string.
    return blockedShellCommand(
      command.startsWith('"') && command.endsWith('"') ? command.slice(1, -1) : command,
    );
  }
  if (name === "which") {
    return blockedLookup(argv.slice(1).filter((arg) => !arg.startsWith("-")));
  }
  if (name === "where") {
    const operands: string[] = [];
    for (let index = 1; index < argv.length; index++) {
      if (argv[index].toLowerCase() === "/r") {
        index++;
      } else if (!argv[index].startsWith("/")) {
        operands.push(argv[index]);
      }
    }
    return blockedLookup(operands);
  }
  if (name === "env") {
    return blockedEnv(argv);
  }
  if (name === "exec") {
    return blockedExec(argv);
  }
  if (name === "command") {
    return blockedCommand(argv);
  }
  if (name === "timeout") {
    return blockedTimeout(argv);
  }
  if (name === "nice") {
    return blockedNice(argv);
  }
  if (name === "nohup") {
    return blockedToolForArgv(argv.slice(argv[1] === "--" ? 2 : 1));
  }
  if (isAssignment(argv[0] ?? "")) {
    const index = argv.findIndex((arg) => !isAssignment(arg));
    return index < 0 ? undefined : blockedToolForArgv(argv.slice(index));
  }
  return undefined;
}

function blockedShellCommand(command: string): string | undefined {
  const { segments, reliable } = tokenizeShellCommand(command);
  if (!reliable) {
    // Exact tokens only: malformed/substitution syntax can reject echo adb,
    // but never merely a substring such as echo myadb. Valid quoted arguments
    // stay arguments and are checked only when they are in command position.
    return blockedLookup(tokenizeShellCommand(command, true).segments.flat());
  }
  for (const segment of segments) {
    const tool = blockedToolForArgv(segment);
    if (tool) {
      return tool;
    }
  }
  return undefined;
}

export function spawnArgv(args: readonly unknown[]): readonly string[] {
  const first = args[0];
  const cmd = Array.isArray(first)
    ? first
    : first !== null && typeof first === "object" && "cmd" in first
      ? first.cmd
      : undefined;
  return Array.isArray(cmd) && cmd.every((arg) => typeof arg === "string") ? cmd : [];
}

function violationMessage(violation: Violation): string {
  return (
    `real device tool spawned: ${violation.testFile}: ${violation.argv.join(" ")} (${violation.tool}). ` +
    "Inject FakeProcessExecutor / fake adb executor / FakeDisplayInventoryProvider / " +
    "PlatformDeviceManagerFactory.setInstance. Existing exceptions live in " +
    "scripts/unit-test-device-spawn-allowlist.txt and may only shrink."
  );
}

/** Fail even when child_process.spawnSync or the caller swallowed the error. */
export function drainViolations(
  report: Violation[],
  matches: (violation: Violation) => boolean = () => true,
): void {
  const violations = report.filter(matches);
  for (let index = report.length - 1; index >= 0; index--) {
    if (matches(report[index])) {
      report.splice(index, 1);
    }
  }
  if (violations.length) {
    throw new Error(violations.map(violationMessage).join("\n"));
  }
}

export function installRealDeviceToolSpawnGuard(deps: SpawnGuardDependencies): () => void {
  if (!deps.getTestFile && !isUnitTestPath(deps.testFile)) {
    return () => {};
  }
  let allowList: ReadonlySet<string> | undefined;
  const originals = { spawn: deps.target.spawn, spawnSync: deps.target.spawnSync };
  const replacements: Partial<SpawnTarget> = {};
  for (const key of ["spawn", "spawnSync"] as const) {
    const original = originals[key];
    if (Reflect.get(original, GUARD_MARKER)) {
      continue;
    }
    const proxy = new Proxy(original, {
      get(target, property, receiver) {
        return property === GUARD_MARKER ? true : Reflect.get(target, property, receiver);
      },
      apply(target, thisArg, args: unknown[]) {
        const argv = spawnArgv(args);
        const tool = blockedToolForArgv(argv);
        if (!tool) {
          return Reflect.apply(target, thisArg, args);
        }
        const testFile = deps.getTestFile?.() ?? deps.testFile;
        if (!isUnitTestPath(testFile)) {
          return Reflect.apply(target, thisArg, args);
        }
        if (deps.mode === "census") {
          deps.record?.(tool, argv, testFile);
          throw Object.assign(new Error(`spawn ${tool} ENOENT (unit-test census blocked launch)`), {
            code: "ENOENT",
          });
        }
        allowList ??= deps.loadAllowList();
        if (allowList.has(testFile)) {
          return Reflect.apply(target, thisArg, args);
        }
        const violation: Violation = {
          testFile,
          tool,
          argv: [...argv],
          testScope: deps.getTestScope?.(testFile),
        };
        deps.report.push(violation);
        deps.onViolation?.(violation);
        throw new Error(violationMessage(violation));
      },
    });
    deps.target[key] = proxy;
    replacements[key] = proxy;
  }
  return () => {
    for (const key of ["spawn", "spawnSync"] as const) {
      if (replacements[key] && deps.target[key] === replacements[key]) {
        deps.target[key] = originals[key];
      }
    }
  };
}
