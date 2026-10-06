import { readFileSync } from "node:fs";
import path from "node:path";
import { wrappedAdbRejection } from "./adbRejection";

/**
 * A `test/fixtures/android-install/*.txt` capture: the daemon log's own record of one failed
 * `adb install` (`$ <command line>`, then `--- stdout` and `--- stderr` sections, then
 * `exit=<code>`), copied verbatim from a real emulator run.
 */
export interface AndroidInstallCapture {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function readAndroidInstallCapture(file: string): AndroidInstallCapture {
  const text = readFileSync(
    path.join(import.meta.dir, "../fixtures/android-install", file),
    "utf8",
  );
  const lines = text.split("\n");
  const command = lines.find((line) => line.startsWith("$ "))?.slice(2) ?? "";
  const sections: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  let current: "stdout" | "stderr" | undefined;
  let exitCode = Number.NaN;
  for (const line of lines) {
    const section = /^--- (stdout|stderr)$/.exec(line);
    const exit = /^exit=(\d+)$/.exec(line);
    if (section) {
      current = section[1] as "stdout" | "stderr";
    } else if (exit) {
      exitCode = Number(exit[1]);
      current = undefined;
    } else if (current) {
      sections[current].push(line);
    }
  }
  // The first token is the adb binary; the rest is what AdbClient passes as arguments.
  return {
    args: command.split(" ").slice(1),
    exitCode,
    stdout: sections.stdout.join("\n"),
    stderr: sections.stderr.join("\n"),
  };
}

/** The rejection a real AdbClient raises for the captured failed install. */
export function adbRejectionFromInstallCapture(capture: AndroidInstallCapture): Error {
  return wrappedAdbRejection(capture);
}
