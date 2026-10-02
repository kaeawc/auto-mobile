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
}

export interface SpawnGuardDependencies {
  target: SpawnTarget;
  testFile: string;
  loadAllowList: () => ReadonlySet<string>;
  mode: "enforce" | "census";
  record?: (tool: string, argv: readonly string[]) => void;
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

function executableName(value: string): string {
  return (value.replaceAll("\\", "/").split("/").pop() ?? "").replace(/\.(exe|cmd|bat)$/i, "");
}

// Deliberately a bounded shell approximation, not a shell interpreter. Quotes
// preserve spaces; operators split command segments (including quoted scripts).
function shellWords(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((word) =>
    word.replace(/^(["'])(.*)\1$/, "$2"),
  );
}

// Bounded unwrapping: sh/bash/zsh/dash -c, cmd /c, which/where lookups,
// env, exec, command, timeout, nice, nohup, and leading NAME=VALUE assignments.
// stdbuf, setsid, sudo, shell functions/substitutions and other wrappers are not
// unwrapped. xcrun is blocked directly, without inspecting its subcommand.
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
    if (["-S", "--split-string"].includes(option) || /^(-S.|--split-string=)/.test(option)) {
      const separate = option === "-S" || option === "--split-string";
      const value = separate
        ? (argv[index + 1] ?? "")
        : option.replace(/^(-S|--split-string=)/, "");
      const rest = argv.slice(index + (separate ? 2 : 1));
      // Split strings can reintroduce env options. Conservatively block any
      // guarded executable word, even when it is behind those options.
      const words = shellWords(value);
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
      const operandIndex = option.search(/[uCa]/);
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
  for (const segment of command.split(/;|&|\||\r?\n/)) {
    const tool = blockedToolForArgv(shellWords(segment.trim()));
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
    "scripts/unit-test-device-spawn-allowlist.txt and may only shrink. " +
    "Re-run with --isolate if you ran several files without it."
  );
}

/** Fail even when child_process.spawnSync or the caller swallowed the error. */
export function drainViolations(report: Violation[]): void {
  const violations = report.splice(0);
  if (violations.length) {
    throw new Error(violations.map(violationMessage).join("\n"));
  }
}

export function installRealDeviceToolSpawnGuard(deps: SpawnGuardDependencies): () => void {
  if (!isUnitTestPath(deps.testFile)) {
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
        if (deps.mode === "census") {
          deps.record?.(tool, argv);
          throw Object.assign(new Error(`spawn ${tool} ENOENT (unit-test census blocked launch)`), {
            code: "ENOENT",
          });
        }
        allowList ??= deps.loadAllowList();
        if (allowList.has(deps.testFile)) {
          return Reflect.apply(target, thisArg, args);
        }
        const violation = { testFile: deps.testFile, tool, argv: [...argv] };
        deps.report.push(violation);
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
