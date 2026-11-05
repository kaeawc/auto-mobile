import { describe, expect, test } from "bun:test";
import {
  createAdbReverseCommands,
  parseAdbReverseList,
} from "../../../src/utils/android-cmdline-tools/adbReverse";

describe("adbReverse", () => {
  test("parses the documented --list rows (device first, host second)", () => {
    // Documented format; not yet captured from a device (#17099).
    const stdout = [
      "UsbFfs tcp:8081 tcp:8081",
      "host-19 tcp:3000 tcp:4000",
      "host-19 tcp:5000 localabstract:dev",
      "host-19 localabstract:x tcp:6000",
      "",
    ].join("\n");
    expect(parseAdbReverseList(stdout)).toEqual([
      { devicePort: 8081, host: "tcp:8081", hostPort: 8081 },
      { devicePort: 3000, host: "tcp:4000", hostPort: 4000 },
      { devicePort: 5000, host: "localabstract:dev" },
    ]);
  });

  test("issues bounded add/remove commands and never --remove-all", async () => {
    const commands: string[] = [];
    const reverse = createAdbReverseCommands({
      executeCommand: async (command: string) => {
        commands.push(command);
        return { stdout: "", stderr: "" } as never;
      },
    });
    await reverse.add(8080, 9090, { noRebind: true });
    await reverse.add(8080, 8080);
    await reverse.remove(8080);
    await reverse.list();
    expect(commands).toEqual([
      "reverse --no-rebind tcp:8080 tcp:9090",
      "reverse tcp:8080 tcp:8080",
      "reverse --remove tcp:8080",
      "reverse --list",
    ]);
  });
});
