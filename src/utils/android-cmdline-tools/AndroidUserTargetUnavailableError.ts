import { type AndroidUser } from "../../models/AndroidUser";

/**
 * Device state was read, but no unambiguous active target can be selected.
 * `kind` separates an ambiguous choice (several managed profiles) from a missing
 * one (no running primary, which is also what an empty or unparsed user list
 * looks like); `users` is every user the device listed, so a caller can tell a
 * single-user device from a multi-user one before deciding how to react.
 */
export class AndroidUserTargetUnavailableError extends Error {
  constructor(
    message: string,
    readonly details: { kind: "ambiguous" | "unavailable"; users: readonly AndroidUser[] } = {
      kind: "unavailable",
      users: [],
    },
  ) {
    super(message);
  }
}
