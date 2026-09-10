import { errorMessage } from "../describeUnknownError";

/** Only missing framework services identify a retryable Android boot failure. */
export function isAndroidFrameworkUnavailable(error: unknown): boolean {
  return /\b(?:can't|cannot) find service:\s*(?:package|settings)(?=$|[\s"'.,;])/i.test(
    errorMessage(error),
  );
}
