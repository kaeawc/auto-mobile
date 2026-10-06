import { readFileSync } from "node:fs";
import path from "node:path";
import { wrappedAdbRejection } from "./adbRejection";

/**
 * One command from a `test/fixtures/android-am-start/*.txt` capture. Each capture is the
 * verbatim terminal log of `adb shell <command>; echo exit=$?` taken on a real emulator:
 * a `$ <command>` line, the command's output, then the `exit=<code>` line.
 */
export interface AmStartCaptureSection {
  command: string;
  output: string;
  exitCode: number;
}

export function readAmStartCapture(file: string): AmStartCaptureSection[] {
  const text = readFileSync(
    path.join(import.meta.dir, "../fixtures/android-am-start", file),
    "utf8",
  );
  const sections: AmStartCaptureSection[] = [];
  let current: { command: string; lines: string[] } | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("$ ")) {
      current = { command: line.slice(2), lines: [] };
      continue;
    }
    const exit = /^exit=(\d+)$/.exec(line);
    if (current && exit) {
      sections.push({
        command: current.command,
        output: current.lines.join("\n"),
        exitCode: Number(exit[1]),
      });
      current = undefined;
      continue;
    }
    current?.lines.push(line);
  }
  return sections;
}

/**
 * The rejection a real AdbClient produces for a command that exits non-zero: node's raw
 * execFile error (carrying `stdout`/`stderr`/`code`) wrapped by `wrapCommandError`, which
 * keeps the raw error as `cause` and echoes the command line in the message. The captures do
 * not record which stream `am`/`monkey` wrote to (the harness merged them), so the caller
 * names the stream.
 */
export function adbRejectionFromCapture(
  section: AmStartCaptureSection,
  stream: "stdout" | "stderr",
): Error {
  return wrappedAdbRejection({
    args: ["shell", section.command],
    exitCode: section.exitCode,
    stdout: stream === "stdout" ? section.output : "",
    stderr: stream === "stderr" ? section.output : "",
  });
}
