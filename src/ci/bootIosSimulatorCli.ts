import { bootCiIosSimulator } from "./bootIosSimulator";

const DEFAULT_CI_IOS_BOOT_TIMEOUT_MS = 300_000;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) { return undefined; }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) { throw new Error(`${name} requires a value.`); }
  return value;
}

function parsePositiveOption(name: string): number | undefined {
  const value = option(name);
  if (value === undefined) { return undefined; }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) { throw new Error(`${name} must be a positive number.`); }
  return parsed;
}

function validateArguments(): void {
  const valueOptions = new Set(["--ios-version", "--timeout-ms", "--max-attempts"]);
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (!valueOptions.has(argument)) { throw new Error(`Unknown argument: ${argument}`); }
    index++;
  }
}

async function main(): Promise<void> {
  validateArguments();
  const result = await bootCiIosSimulator({
    iosVersion: option("--ios-version"),
    timeoutMs: parsePositiveOption("--timeout-ms") ?? DEFAULT_CI_IOS_BOOT_TIMEOUT_MS,
    maxAttempts: parsePositiveOption("--max-attempts"),
  });
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
