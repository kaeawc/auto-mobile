import { isAndroidEmulatorSerial } from "../androidSerial";
import { EmulatorStopDispatchedError } from "./EmulatorStopDispatchedError";
import type { Candidate } from "./EmulatorProcessStop";

export function serialPort(serial: string): number | undefined {
  return isAndroidEmulatorSerial(serial) ? Number(serial.slice("emulator-".length)) : undefined;
}

/** ps has no quoting; only whitespace-free AVD names and explicit ports prove identity. */
export function emulatorProcessArguments(command: string): { avdName?: string; port?: number } {
  const args = command.split(/\s+/);
  const avdIndex = args.indexOf("-avd");
  const avdName =
    avdIndex >= 0 ? args[avdIndex + 1] : args.find((arg) => arg.startsWith("@"))?.slice(1);
  const ports = args.flatMap((arg, index) => {
    if (arg === "-port" || arg === "-ports") {
      return [args[index + 1]?.split(",")[0]];
    }
    const inline = /^-ports?=(.*)$/.exec(arg);
    return inline ? [inline[1].split(",")[0]] : [];
  });
  const port = ports.length === 1 && /^\d+$/.test(ports[0] ?? "") ? Number(ports[0]) : undefined;
  return { avdName: avdName && !avdName.startsWith("-") ? avdName : undefined, port };
}

/** Keep diagnostics short rather than printing the complete ps command. */
export function emulatorProcessEscapeHint(
  serial: string,
  candidates: Candidate[] = [],
  tableStatus?: "absent" | "unreadable",
): string {
  if (candidates.length > 0) {
    const descriptions = candidates.map(({ pid, command }) => {
      const executable = command.match(/qemu-system-[^/\s]+/)?.[0] ?? "qemu-system-*";
      const { avdName, port } = emulatorProcessArguments(command);
      return `process ${pid} (\`${executable}${avdName ? ` -avd ${avdName}` : ""} -port ${port}\`); \`kill ${pid}\``;
    });
    return `Stop it by hand after checking its identity: ${descriptions.join("; ")} stops it even when the console does not answer (\`adb -s ${serial} emu kill\` goes through the same console).`;
  }
  const detail =
    tableStatus === "absent"
      ? "The process table has no emulator candidate with this explicit port."
      : tableStatus === "unreadable"
        ? "The process table could not be read."
        : "No process table was consulted.";
  return `${detail} Find and check it with \`ps -axo pid=,command= | grep -- '-port ${serialPort(serial) ?? "<port>"}'\`, then use \`kill <pid>\`. Use \`adb -s ${serial} emu kill\` only if the console answers.`;
}

export class EmulatorStillRunningError extends EmulatorStopDispatchedError {
  constructor(
    readonly pid: number,
    readonly serial: string,
    readonly avdName: string,
    command: string,
  ) {
    super(
      `Emulator '${serial}' (AVD '${avdName}') is still running with pid ${pid}. ${emulatorProcessEscapeHint(serial, [{ pid, command }])}`,
    );
  }
}
