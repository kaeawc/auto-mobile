import type { ExecResult } from "../../models";

/** Parsed `profiles status -type enrollment` output. */
export interface MdmEnrollment {
  enrolled: boolean;
}

/**
 * Parse `profiles status -type enrollment`, which prints
 * `Enrolled via DEP: <Yes|No>` and `MDM enrollment: <Yes|No> [(User Approved)]`.
 * Either line starting with "Yes" means the Mac is managed.
 */
export function parseMdmEnrollment(stdout: string): MdmEnrollment {
  const enrolled = stdout
    .split("\n")
    .some((line) => /^\s*(Enrolled via DEP|MDM enrollment):\s*Yes\b/i.test(line));
  return { enrolled };
}

/** The exec seam the enrollment probe needs; matches `IosDoctorDependencies.execFile`. */
export type MdmExecFile = (
  file: string,
  args: string[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<ExecResult>;

export async function detectMdmEnrollment(
  execFile: MdmExecFile,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MdmEnrollment> {
  const result = await execFile("profiles", ["status", "-type", "enrollment"], options);
  return parseMdmEnrollment(result.stdout);
}
