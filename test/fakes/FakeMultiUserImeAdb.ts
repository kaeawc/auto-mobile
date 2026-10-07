import type { ExecResult } from "../../src/models";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

interface UserImeState {
  active: string | null;
  enabled: string[];
  subtype: string | null;
}

/**
 * Per-user IME state behind the `ime` and `settings` shell commands, applying the AOSP
 * defaults when `--user` is omitted: `ime` acts on the foreground user, `settings` on user 0.
 */
export class FakeMultiUserImeAdb implements Pick<AdbExecutor, "execute"> {
  readonly calls: string[][] = [];
  private readonly users = new Map<number, UserImeState>();

  constructor(
    private readonly foregroundUser: number,
    private readonly installed: string[],
  ) {}

  seedUser(userId: number, state: Partial<UserImeState> & { active: string }): void {
    this.users.set(userId, { enabled: [state.active], subtype: null, ...state });
  }

  state(userId: number): UserImeState {
    const state = this.users.get(userId);
    if (!state) {
      throw new Error(`user ${userId} was not seeded`);
    }
    return state;
  }

  execute = async (args: string[]): Promise<ExecResult> => {
    this.calls.push(args);
    if (args[1] === "dumpsys") {
      // Subtype tables are not modelled; an empty dump means "unavailable, verify by readback".
      return reply("");
    }
    const words = args.slice(1);
    const flag = words.indexOf("--user");
    const positional = flag < 0 ? words : words.filter((_, i) => i !== flag && i !== flag + 1);
    const defaultUser = positional[0] === "ime" ? this.foregroundUser : 0;
    const state = this.state(flag < 0 ? defaultUser : Number(words[flag + 1]));
    return this.run(positional, state);
  };

  private run(words: string[], state: UserImeState): ExecResult {
    const [tool, verb, ...rest] = words;
    if (tool === "ime" && verb === "list") {
      return reply((rest.includes("-a") ? this.installed : state.enabled).join("\n") + "\n");
    }
    if (tool === "ime" && verb === "set") {
      state.active = rest[0];
      return reply("");
    }
    if (tool === "settings" && verb === "get") {
      const value = rest[1] === "default_input_method" ? state.active : state.subtype;
      return reply(`${value ?? "null"}\n`);
    }
    if (tool === "settings" && (verb === "put" || verb === "delete")) {
      state.subtype = verb === "put" ? rest[2] : null;
      return reply("");
    }
    return reply("", `unexpected command: ${words.join(" ")}`);
  }
}

function reply(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}
