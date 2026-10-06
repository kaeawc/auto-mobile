import { readFileSync } from "node:fs";

/** The package the `cmd locale` captures were taken against (installed on the capture device). */
export const LOCALE_CAPTURE_APP_ID = "dev.jasonpearson.automobile.playground";

/** The package that is NOT installed on the capture device (`locale-missing-package-*.txt`). */
export const LOCALE_CAPTURE_MISSING_APP_ID = "com.example.missing.pkg";

/**
 * The thirteen device states captured after each step of the manual locale test, in
 * `test/fixtures/android-locale/locale-after-<name>-emulator-5600.txt`. The step name is the
 * request that was sent just before the capture; for the malformed and over-long tags that is a
 * request the tool rejected before sending, so the capture shows the previous app locale unchanged.
 */
export type LocaleCaptureName =
  | "0-initial"
  | "1-he"
  | "2-iw"
  | "3-zz-ZZ"
  | "4-malformed-not_a_locale"
  | "5-malformed-double-hyphen"
  | "6-he-IL"
  | "7-fr-FR"
  | "8-overlong-subtags"
  | "9-x-private"
  | "10-und"
  | "11-in-ID"
  | "12-restored";

/** One captured shell command: its text, exactly what it printed, and the echoed exit code if any. */
export interface CapturedCommand {
  readonly command: string;
  /** Verbatim output, every line newline-terminated as the device printed it. */
  readonly output: string;
  readonly exitCode: number | null;
}

const PROMPT = /^\$ adb -s \S+ shell (.*)$/;
const EXIT_ECHO = /^exit=(\d+)$/;
const EXIT_SUFFIX = "; echo exit=$?";

/**
 * Split a capture file into its commands. The file is a transcript (`$ adb -s <serial> shell
 * <command>` followed by the output); it is read, never edited. A capture taken with
 * `; echo exit=$?` ends each output with an `exit=N` line, which is returned as `exitCode`
 * rather than as device output.
 */
export function parseLocaleCapture(text: string): CapturedCommand[] {
  const commands: CapturedCommand[] = [];
  let current: { command: string; lines: string[] } | null = null;
  const finish = (): void => {
    if (!current) {
      return;
    }
    const last = current.lines[current.lines.length - 1];
    const exit = last === undefined ? null : EXIT_ECHO.exec(last);
    const lines = exit ? current.lines.slice(0, -1) : current.lines;
    commands.push({
      command: current.command,
      output: lines.map((line) => `${line}\n`).join(""),
      exitCode: exit ? Number(exit[1]) : null,
    });
  };
  for (const line of text.split("\n").slice(0, -1)) {
    const prompt = PROMPT.exec(line);
    if (prompt) {
      finish();
      const command = prompt[1] ?? "";
      current = {
        command: command.endsWith(EXIT_SUFFIX) ? command.slice(0, -EXIT_SUFFIX.length) : command,
        lines: [],
      };
    } else {
      current?.lines.push(line);
    }
  }
  finish();
  return commands;
}

function readCapture(file: string): CapturedCommand[] {
  return parseLocaleCapture(
    readFileSync(new URL(`../fixtures/android-locale/${file}`, import.meta.url), "utf8"),
  );
}

function outputOf(commands: CapturedCommand[], command: string): CapturedCommand {
  const found = commands.find((candidate) => candidate.command === command);
  if (!found) {
    throw new Error(`capture has no command "${command}"`);
  }
  return found;
}

/** What the device printed in one `locale-after-*` capture. */
export interface LocaleCapture {
  /** `getprop persist.sys.locale`: empty in every capture (device-wide locale was not exercised). */
  readonly persistSysLocale: string;
  /** `cmd locale get-app-locales <pkg>` (no `--user`). */
  readonly appLocales: string;
  /** `cmd locale get-app-locales <pkg> --user 0`: the exact command the adapter sends. */
  readonly appLocalesUser0: string;
  /** `settings get system system_locales`. */
  readonly systemLocales: string;
}

export function readLocaleCapture(name: LocaleCaptureName): LocaleCapture {
  const commands = readCapture(`locale-after-${name}-emulator-5600.txt`);
  const get = `cmd locale get-app-locales ${LOCALE_CAPTURE_APP_ID}`;
  return {
    persistSysLocale: outputOf(commands, "getprop persist.sys.locale").output,
    appLocales: outputOf(commands, get).output,
    appLocalesUser0: outputOf(commands, `${get} --user 0`).output,
    systemLocales: outputOf(commands, "settings get system system_locales").output,
  };
}

/** The `Unknown package` replies of `locale-missing-package-emulator-5600.txt`. */
export interface MissingPackageCapture {
  readonly getAppLocales: CapturedCommand;
  readonly setAppLocales: CapturedCommand;
  readonly getAppLocalesUser0: CapturedCommand;
}

export function readMissingPackageCapture(): MissingPackageCapture {
  const commands = readCapture("locale-missing-package-emulator-5600.txt");
  const pkg = LOCALE_CAPTURE_MISSING_APP_ID;
  return {
    getAppLocales: outputOf(commands, `cmd locale get-app-locales ${pkg}`),
    setAppLocales: outputOf(commands, `cmd locale set-app-locales ${pkg} --user 0 --locales fr-FR`),
    getAppLocalesUser0: outputOf(commands, `cmd locale get-app-locales ${pkg} --user 0`),
  };
}
