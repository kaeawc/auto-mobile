import { commandFailureDetails } from "../CommandError";

/** Read the remote command's streams from a rejected adb call. */
export function adbFailureOutput(error: unknown): { stdout: string; stderr: string } {
  const { stdout, stderr } = commandFailureDetails(error);
  return { stdout, stderr };
}
