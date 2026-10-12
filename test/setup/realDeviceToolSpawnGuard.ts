/**
 * Unit-only process boundary. No I/O or process access: the preload supplies both.
 *
 * A unit test may not launch a host process. Every launch from a unit test file throws unless the
 * checked-in allow-list names that file and that command, and the tools below are refused even
 * when listed: they reach a device, a simulator, the host's settings or the resident daemon.
 */
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
  // Host appearance: the daemon's appearance sync reads these before it runs adb.
  "defaults",
  "gsettings",
  // The CLI talks to the resident daemon unless every one of its paths is overridden.
  "auto-mobile",
]);
// The resident daemon's /tmp state files. An isolated daemon's carry a `-<hash>` suffix.
const RESIDENT_DAEMON_PATH = /auto-mobile-daemon-(\d+|default)\.(sock|pid|lock)\b/;
/** The allow-list command for a `Bun.$` template. */
export const BUN_SHELL_COMMAND = "Bun.$";
const UNPARSED_COMMAND = "(unparsed)";
// Launchers that run their arguments as another command and that the guard does not unwrap, so
// an entry for one would permit anything.
const OPAQUE_WRAPPERS = new Set([
  "sudo",
  "doas",
  "xargs",
  "script",
  "osascript",
  "stdbuf",
  "setsid",
  "eval",
  "open",
]);
const GUARD_MARKER = Symbol("realDeviceToolSpawnGuard");
type SpawnFunction = (...args: never[]) => unknown;

export interface SpawnTarget {
  spawn: SpawnFunction;
  spawnSync: SpawnFunction;
  /** Bun's shell. It launches commands itself, not through `spawn`, so it is guarded too. */
  $?: SpawnFunction;
}

export interface Violation {
  testFile: string;
  /** The never-allow-listable tool, or the command an allow-list entry would have to name. */
  tool: string;
  argv: readonly string[];
  /** True when no allow-list entry can permit this launch. */
  forbidden?: boolean;
  /** The frames that launched it: a swallowed launch is reported later, from a hook. */
  origin?: string;
  testScope?: object;
}

/** Test file to the commands it may launch. */
export type HostSpawnAllowList = ReadonlyMap<string, ReadonlySet<string>>;

export interface SpawnGuardDependencies {
  target: SpawnTarget;
  testFile: string;
  getTestFile?: () => string;
  getTestScope?: (testFile: string) => object | undefined;
  onViolation?: (violation: Violation) => void;
  loadAllowList: () => HostSpawnAllowList;
  /** Census records every launch; it lets the listable ones run and refuses the rest. */
  mode: "enforce" | "census";
  record?: (tool: string, argv: readonly string[], testFile: string, forbidden: boolean) => void;
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

/** The tool or path that no allow-list entry can permit, if this launch names one. */
export function neverAllowListable(argv: readonly string[]): string | undefined {
  const command = executableName(argv[0] ?? "").toLowerCase();
  return (
    blockedToolForArgv(argv) ??
    // macOS and Windows resolve `ADB` to adb: the device rule ignores case.
    blockedToolForArgv(argv.map((arg) => arg.toLowerCase())) ??
    (OPAQUE_WRAPPERS.has(command) ? command : undefined) ??
    (argv.some((arg) => RESIDENT_DAEMON_PATH.test(arg)) ? "resident daemon socket" : undefined)
  );
}

/** The name an allow-list entry uses for a launch: the executable, without directory or `.exe`. */
export function hostCommandName(argv: readonly string[]): string {
  return executableName(argv[0] ?? "") || UNPARSED_COMMAND;
}

export interface HostSpawnAllowListParse {
  allowList: HostSpawnAllowList;
  /** One message per line that is not `<unit test file> <command>` or names a refused tool. */
  errors: string[];
}

/**
 * One entry per line, `<repo-relative unit test file> <command>`; `#` starts a comment. A refused
 * line is reported and dropped, so a listed `adb` permits nothing.
 */
export function parseHostSpawnAllowList(text: string): HostSpawnAllowListParse {
  const allowList = new Map<string, Set<string>>();
  const errors: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [testFile, command, ...extra] = line.split(/\s+/);
    const where = `line ${index + 1}`;
    if (!command || extra.length) {
      errors.push(`${where}: expected "<unit test file> <command>", got "${line}"`);
    } else if (!testFile.startsWith("test/") || !isUnitTestPath(testFile)) {
      errors.push(`${where}: ${testFile} is not a repo-relative unit test file`);
    } else if (command !== BUN_SHELL_COMMAND && command !== executableName(command)) {
      errors.push(`${where}: ${command} must be a bare command name, not a path`);
    } else if (neverAllowListable([command]) || command === UNPARSED_COMMAND) {
      errors.push(`${where}: ${command} can never be allow-listed`);
    } else {
      allowList.set(testFile, (allowList.get(testFile) ?? new Set()).add(command));
    }
  }
  return { allowList, errors };
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

/** An interpolated value as Bun's shell reads it: arrays are separate words, `{ raw }` is text. */
function shellValueText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(shellValueText).join(" ");
  }
  if (value !== null && typeof value === "object" && "raw" in value) {
    return String(value.raw);
  }
  return String(value);
}

/** A `Bun.$` template call as the command line the shell would run. */
function shellTemplateText(args: readonly unknown[]): string {
  const [strings, ...values] = args;
  if (!Array.isArray(strings)) {
    return "";
  }
  return strings
    .map((part, index) => `${part}${index < values.length ? shellValueText(values[index]) : ""}`)
    .join("");
}

function violationMessage(violation: Violation): string {
  const launch = `${violation.testFile}: ${violation.argv.join(" ")} (${violation.tool})`;
  const origin = violation.origin ? `\nLaunched from:\n${violation.origin}` : "";
  if (violation.forbidden) {
    return (
      `real device tool spawned: ${launch}. ` +
      "Inject FakeProcessExecutor / fake adb executor / FakeDisplayInventoryProvider / " +
      "PlatformDeviceManagerFactory.setInstance. Device, simulator, host-settings and " +
      `resident-daemon commands can never be allow-listed.${origin}`
    );
  }
  return (
    `host command spawned by a unit test: ${launch}. ` +
    "Inject a fake (FakeProcessExecutor, or the consumer's own executor seam). Only for a " +
    `harmless local tool, add "${violation.testFile} ${violation.tool}" with a comment to ` +
    `scripts/unit-test-host-spawn-allowlist.txt.${origin}`
  );
}

/** The caller's frames, without the runtime's own and without this guard's. */
function launchOrigin(): string | undefined {
  const previousLimit = Error.stackTraceLimit;
  // An executor seam is a dozen frames below the code that chose to launch.
  Error.stackTraceLimit = Math.max(previousLimit, 64);
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = previousLimit;
  const frames = stack
    .split("\n")
    .slice(1)
    .filter(
      (frame) =>
        !/\(node:|\(native|\(unknown\)|at unknown$|realDeviceToolSpawnGuard\.ts:/.test(frame),
    );
  return frames.length ? frames.slice(0, 16).join("\n") : undefined;
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

/**
 * Replace `spawn`, `spawnSync` and `$` on `deps.target` (Bun). `node:child_process` needs no
 * patch of its own: Bun implements `spawn`, `exec`, `execFile`, `fork` and their sync forms by
 * reading `Bun.spawn`/`Bun.spawnSync` at each call, including for bindings imported earlier.
 */
export function installRealDeviceToolSpawnGuard(deps: SpawnGuardDependencies): () => void {
  if (!deps.getTestFile && !isUnitTestPath(deps.testFile)) {
    return () => {};
  }
  let allowList: HostSpawnAllowList | undefined;
  /** Throws unless this launch may run. */
  const admit = (argv: readonly string[], command: string, forbiddenTool?: string): void => {
    const testFile = deps.getTestFile?.() ?? deps.testFile;
    if (!isUnitTestPath(testFile)) {
      return;
    }
    const tool = forbiddenTool ?? command;
    if (deps.mode === "census") {
      deps.record?.(tool, argv, testFile, forbiddenTool !== undefined);
      if (forbiddenTool === undefined) {
        return;
      }
      throw Object.assign(new Error(`spawn ${tool} ENOENT (unit-test census blocked launch)`), {
        code: "ENOENT",
      });
    }
    if (forbiddenTool === undefined) {
      allowList ??= deps.loadAllowList();
      if (allowList.get(testFile)?.has(command)) {
        return;
      }
    }
    const violation: Violation = {
      testFile,
      tool,
      argv: [...argv],
      forbidden: forbiddenTool !== undefined,
      origin: launchOrigin(),
      testScope: deps.getTestScope?.(testFile),
    };
    deps.report.push(violation);
    deps.onViolation?.(violation);
    throw new Error(violationMessage(violation));
  };
  const admitShell = (text: string): void =>
    admit([BUN_SHELL_COMMAND, text], BUN_SHELL_COMMAND, neverAllowListable(["sh", "-c", text]));
  const guarded = (original: SpawnFunction, key: keyof SpawnTarget): SpawnFunction =>
    new Proxy(original, {
      // No trap can swap `$.Shell` for a guarded constructor: Bun defines it non-configurable and
      // non-writable, and a proxy must report such a property unchanged.
      get(target, property, receiver) {
        return property === GUARD_MARKER ? true : Reflect.get(target, property, receiver);
      },
      apply(target, thisArg, args: unknown[]) {
        if (key === "$") {
          admitShell(shellTemplateText(args));
        } else {
          const argv = spawnArgv(args);
          admit(argv, hostCommandName(argv), neverAllowListable(argv));
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  const keys = ["spawn", "spawnSync", "$"] as const;
  const originals: Partial<SpawnTarget> = {};
  const replacements: Partial<SpawnTarget> = {};
  for (const key of keys) {
    const original = deps.target[key];
    if (!original || Reflect.get(original, GUARD_MARKER)) {
      continue;
    }
    originals[key] = original;
    replacements[key] = deps.target[key] = guarded(original, key);
  }
  return () => {
    for (const key of keys) {
      const original = originals[key];
      if (original && deps.target[key] === replacements[key]) {
        deps.target[key] = original;
      }
    }
  };
}
