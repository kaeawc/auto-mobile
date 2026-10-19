export function extractInstallErrorText(error: unknown): string {
  if (error instanceof Error) {
    const details = {
      stderr: "stderr" in error ? error.stderr : undefined,
      stdout: "stdout" in error ? error.stdout : undefined,
    };
    return [error.message, details.stderr, details.stdout]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join("\n");
  }
  return String(error);
}

export function diffInstalledPackages(before: Set<string>, after: Set<string>): string[] {
  const added: string[] = [];
  for (const item of after) {
    if (!before.has(item)) {
      added.push(item);
    }
  }
  return added.sort();
}
