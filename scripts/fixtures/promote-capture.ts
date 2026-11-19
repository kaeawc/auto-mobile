/**
 * Promote one captured command output into test/fixtures (#18770).
 *
 *   bun scripts/fixtures/promote-capture.ts --capture <tool-call dir> --command <index> \
 *     --dest test/fixtures/<area>/<form-factor>/<name>.txt [--stream stdout|stderr]
 *
 * Reads a capture written under AUTOMOBILE_CAPTURE_FIXTURES_DIR, redacts the device id and
 * host paths, writes the fixture and a `<name>.provenance.json` sidecar, pins the directory to
 * `text eol=lf` in .gitattributes when git does not already, and formats the sidecar with oxfmt.
 * It refuses a capture without a device, OS version or clean source commit. See
 * docs/how-it-works/fixture-capture.md.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  CAPTURE_COMMANDS_FILE,
  CAPTURE_PROVENANCE_FILE,
  FIXTURE_CAPTURE_SCHEMA_VERSION,
  type CapturedCommand,
} from "../../src/utils/fixtureCapture/fixtureCaptureFormat";
import type { FormFactor } from "../../src/models/DeviceMatchCriteria";

/** Form-factor directory names: the device model's values, minus "unknown". */
export const FIXTURE_FORM_FACTORS = [
  "phone",
  "tablet",
  "foldable",
  "tv",
  "watch",
  "automotive",
  "xr-headset",
  "xr-glasses",
] as const satisfies readonly FormFactor[];
export type FixtureFormFactor = (typeof FIXTURE_FORM_FACTORS)[number];

const deviceSchema = z.object({
  platform: z.enum(["android", "ios", "watchos", "tvos", "visionos"]),
  deviceId: z.string().min(1),
  name: z.string().optional(),
  model: z.string().optional(),
  deviceType: z.string().optional(),
  formFactor: z.string().optional(),
  osVersion: z.string().optional(),
  apiLevel: z.number().optional(),
  iosVersion: z.string().optional(),
  runtimeId: z.string().optional(),
  runtime: z.string().optional(),
});

const provenanceSchema = z.object({
  schemaVersion: z.literal(FIXTURE_CAPTURE_SCHEMA_VERSION),
  tool: z.object({ name: z.string().min(1) }),
  captureDate: z.string().min(1),
  automobileVersion: z.string().min(1),
  sourceTreeState: z.enum(["clean", "dirty", "unknown"]),
  device: deviceSchema.optional(),
});

const commandSchema = z.object({
  index: z.number().int(),
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  exitCode: z.number().int().nullable(),
  signal: z.string().optional(),
  errorCode: z.string().optional(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  redacted: z.literal(true).optional(),
  truncated: z.literal(true).optional(),
});

export interface ParsedCapture {
  provenance: z.infer<typeof provenanceSchema>;
  commands: CapturedCommand[];
}

export function parseCapture(provenanceText: string, commandsText: string): ParsedCapture {
  return {
    provenance: provenanceSchema.parse(JSON.parse(provenanceText)),
    commands: z.array(commandSchema).parse(JSON.parse(commandsText)),
  };
}

export interface FixtureDestination {
  /** Repository-relative, `/`-separated. */
  relativePath: string;
  area: string;
  formFactor: FixtureFormFactor;
}

export function parseFixtureDestination(dest: string): FixtureDestination {
  const relativePath = path.posix.normalize(dest.split(path.sep).join("/"));
  const parts = relativePath.split("/");
  const [root, fixtures, area, formFactor, file] = parts;
  if (parts.length !== 5 || root !== "test" || fixtures !== "fixtures" || !area || !file) {
    throw new Error(`--dest must be test/fixtures/<area>/<form-factor>/<name>.txt, got ${dest}`);
  }
  if (!file.endsWith(".txt")) {
    throw new Error(`--dest must be a .txt file (oxfmt rewrites other formats), got ${file}`);
  }
  if (!(FIXTURE_FORM_FACTORS as readonly string[]).includes(formFactor ?? "")) {
    throw new Error(
      `form-factor directory must be one of ${FIXTURE_FORM_FACTORS.join(", ")}, got ${formFactor}`,
    );
  }
  return { relativePath, area, formFactor: formFactor as FixtureFormFactor };
}

/**
 * The commit a capture was taken from. Refuses a dirty or unstamped build, and a capture whose
 * daemon never established the tree was clean (its dirty probe failed or timed out).
 */
export function sourceCommitOfCapture(provenance: ParsedCapture["provenance"]): string {
  const commit = sourceCommitOf(provenance.automobileVersion);
  if (provenance.sourceTreeState !== "clean") {
    throw new Error(
      `capture source tree state is ${provenance.sourceTreeState}, not clean; commit, then recapture`,
    );
  }
  return commit;
}

/** The commit a source-checkout version names (`+g<sha>`); refuses a dirty or unstamped build. */
export function sourceCommitOf(automobileVersion: string): string {
  const match = /\+g([0-9a-f]{7,40})(\.dirty)?/.exec(automobileVersion);
  if (!match) {
    throw new Error(
      `capture version ${automobileVersion} names no source commit; capture from a source checkout`,
    );
  }
  if (match[2]) {
    throw new Error(
      `capture version ${automobileVersion} is from a dirty checkout; commit, then recapture`,
    );
  }
  return match[1] as string;
}

export interface Redaction {
  secret: string;
  token: string;
}

export function redactText(text: string, redactions: readonly Redaction[]): string {
  return redactions
    .filter((redaction) => redaction.secret.length > 0)
    .reduce((redacted, { secret, token }) => redacted.split(secret).join(token), text);
}

export interface FixtureProvenance {
  schemaVersion: typeof FIXTURE_CAPTURE_SCHEMA_VERSION;
  provenance: "captured";
  tool: string;
  argv: string[];
  exitCode: number | null;
  stream: "stdout" | "stderr";
  captureDate: string;
  sourceCommit: string;
  automobileVersion: string;
  device: {
    platform: PromotionDevice["platform"];
    formFactor: FixtureFormFactor;
    /** True when the device did not report a form factor and the --dest directory supplied it. */
    formFactorDeclared?: true;
    model?: string;
    deviceType?: string;
    osVersion?: string;
    apiLevel?: number;
    runtimeId?: string;
  };
}

export interface PromotionInput {
  capture: ParsedCapture;
  commandIndex: number;
  stream: "stdout" | "stderr";
  destination: FixtureDestination;
  /** Host paths replaced by `~`. */
  homeDir: string;
}

export interface Promotion {
  fixture: string;
  provenance: FixtureProvenance;
}

type PromotionDevice = z.infer<typeof deviceSchema>;

function promotionDevice(
  capture: ParsedCapture,
  destination: FixtureDestination,
): { device: PromotionDevice; declared: boolean } {
  const device = capture.provenance.device;
  if (!device) {
    throw new Error(
      `capture of ${capture.provenance.tool.name} resolved no device; nothing to attribute`,
    );
  }
  if (device.osVersion === undefined && device.apiLevel === undefined && !device.iosVersion) {
    throw new Error(`capture device ${device.platform} reports no OS version or API level`);
  }
  const reported = device.formFactor === "unknown" ? undefined : device.formFactor;
  if (reported && reported !== destination.formFactor) {
    throw new Error(`capture device is a ${reported}, but --dest names ${destination.formFactor}`);
  }
  return { device, declared: !reported };
}

export function buildPromotion(input: PromotionInput): Promotion {
  const { capture, commandIndex, stream, destination, homeDir } = input;
  const command = capture.commands.find((entry) => entry.index === commandIndex);
  if (!command) {
    throw new Error(`capture has no command ${commandIndex} (it has ${capture.commands.length})`);
  }
  if (command.redacted) {
    throw new Error(
      `command ${commandIndex} was redacted at capture time (password input or a scrubbed secret) and cannot be promoted`,
    );
  }
  if (command.truncated) {
    throw new Error(
      `command ${commandIndex} output was truncated at a capture limit and cannot be promoted`,
    );
  }
  const { device, declared } = promotionDevice(capture, destination);
  const sourceCommit = sourceCommitOfCapture(capture.provenance);
  const redactions: Redaction[] = [
    { secret: device.deviceId, token: device.platform === "android" ? "<serial>" : "<udid>" },
    { secret: homeDir, token: "~" },
  ];
  const [executable = "", ...args] = command.argv;
  const osVersion = device.osVersion ?? device.iosVersion;
  return {
    fixture: redactText(command[stream], redactions),
    provenance: {
      schemaVersion: FIXTURE_CAPTURE_SCHEMA_VERSION,
      provenance: "captured",
      tool: capture.provenance.tool.name,
      argv: [path.basename(executable), ...args.map((arg) => redactText(arg, redactions))],
      exitCode: command.exitCode,
      stream,
      captureDate: capture.provenance.captureDate,
      sourceCommit,
      automobileVersion: capture.provenance.automobileVersion,
      device: {
        platform: device.platform,
        formFactor: destination.formFactor,
        ...(declared ? { formFactorDeclared: true as const } : {}),
        ...(device.model ? { model: device.model } : {}),
        ...(device.deviceType ? { deviceType: device.deviceType } : {}),
        ...(osVersion ? { osVersion } : {}),
        ...(device.apiLevel === undefined ? {} : { apiLevel: device.apiLevel }),
        ...(device.runtimeId ? { runtimeId: device.runtimeId } : {}),
      },
    },
  };
}

/** The `.gitattributes` line that pins a promoted fixture directory to LF. */
export function eolPinLine(destination: FixtureDestination): string {
  return `test/fixtures/${destination.area}/${destination.formFactor}/* text eol=lf`;
}

/**
 * Insert `pin` next to a related entry: after the last line for the same fixture area, else after
 * the last test/fixtures line, else at the end. Unchanged when the line is already present.
 */
export function withEolPin(gitattributes: string, pin: string, area: string): string {
  const lines = gitattributes.split("\n");
  if (lines.includes(pin)) {
    return gitattributes;
  }
  const lastIndex = (prefix: string) => lines.findLastIndex((line) => line.startsWith(prefix));
  const sameArea = lastIndex(`test/fixtures/${area}/`);
  const anyFixture = sameArea >= 0 ? sameArea : lastIndex("test/fixtures/");
  if (anyFixture < 0) {
    const trimmed = gitattributes.endsWith("\n") ? gitattributes : `${gitattributes}\n`;
    return `${trimmed}${pin}\n`;
  }
  return [...lines.slice(0, anyFixture + 1), pin, ...lines.slice(anyFixture + 1)].join("\n");
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      capture: { type: "string" },
      command: { type: "string" },
      dest: { type: "string" },
      stream: { type: "string", default: "stdout" },
    },
  });
  if (!values.capture || values.command === undefined || !values.dest) {
    throw new Error(
      "usage: --capture <dir> --command <index> --dest test/fixtures/<area>/<ff>/<name>.txt",
    );
  }
  if (values.stream !== "stdout" && values.stream !== "stderr") {
    throw new Error(`--stream must be stdout or stderr, got ${values.stream}`);
  }
  const repoRoot = run("git", ["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const destination = parseFixtureDestination(values.dest);
  const capture = parseCapture(
    readFileSync(path.join(values.capture, CAPTURE_PROVENANCE_FILE), "utf8"),
    readFileSync(path.join(values.capture, CAPTURE_COMMANDS_FILE), "utf8"),
  );
  const promotion = buildPromotion({
    capture,
    commandIndex: Number(values.command),
    stream: values.stream,
    destination,
    homeDir: homedir(),
  });
  const fixturePath = path.join(repoRoot, destination.relativePath);
  const sidecarPath = fixturePath.replace(/\.txt$/, ".provenance.json");
  mkdirSync(path.dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, promotion.fixture);
  writeFileSync(sidecarPath, `${JSON.stringify(promotion.provenance, null, 2)}\n`);
  const eol = run("git", ["check-attr", "eol", "--", destination.relativePath], repoRoot);
  if (!eol.trim().endsWith(": lf")) {
    const attributesPath = path.join(repoRoot, ".gitattributes");
    const current = readFileSync(attributesPath, "utf8");
    writeFileSync(attributesPath, withEolPin(current, eolPinLine(destination), destination.area));
  }
  run("bunx", ["oxfmt", sidecarPath], repoRoot);
  process.stdout.write(`Promoted ${destination.relativePath} (+ provenance sidecar)\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
