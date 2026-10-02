import { FakeAdbExecutor } from "./FakeAdbExecutor";
import { createExecResult } from "../../src/utils/execResult";
import type { AdbExecuteOptions } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

export const bootId = "11111111-1111-4111-8111-111111111111";
export class ResourceAdb extends FakeAdbExecutor {
  packages = new Map([["com.google.android.gm", "0"]]);
  settings = new Map<string, string>();
  commands: string[][] = [];
  role = "";
  backupEnabled = true;
  ignoreWrites = false;
  onCommand?: () => void;
  override async execute(args: string[], options?: AdbExecuteOptions) {
    options?.signal?.throwIfAborted();
    const words = args[1]!.slice(1, -1).split("' '");
    this.commands.push(words);
    this.onCommand?.();
    const [verb, command] = words;
    let output = "";
    if (verb === "am") {
      output = "0";
    } else if (verb === "cat") {
      output = bootId;
    } else if (verb === "pm" && command === "list") {
      output = [...this.packages.keys()].map((name) => `package:${name}`).join("\n");
    } else if (verb === "dumpsys" && command === "package") {
      output = ` User 0: installed=true hidden=false suspended=false enabled=${this.packages.get(words[2]!)}\n User 0:\n verification state`;
    } else if (verb === "dumpsys") {
      output = "mResumedActivity: com.android.launcher3/.Launcher";
    } else if (verb === "cmd") {
      output = this.role;
    } else if (verb === "bmgr") {
      if (words[3] === "enable" && !this.ignoreWrites) {
        this.backupEnabled = words[4] === "true";
      }
      output = `Backup Manager currently ${this.backupEnabled ? "enabled" : "disabled"}`;
    } else if (verb === "settings") {
      const key = words[5]!;
      if (words[3] === "get") {
        output = this.settings.get(key) ?? "null";
      } else if (!this.ignoreWrites) {
        if (words[3] === "delete") {
          this.settings.delete(key);
        } else {
          this.settings.set(key, words[6]!);
        }
      }
    } else if (verb === "pm" && !this.ignoreWrites) {
      this.packages.set(
        words[4]!,
        String(
          ["default-state", "enable", "disable", "disable-user", "disable-until-used"].indexOf(
            command!,
          ),
        ),
      );
    } else if (verb !== "pm") {
      throw new Error(`Unhandled command ${words.join(" ")}`);
    }
    return createExecResult(output, "");
  }
}
