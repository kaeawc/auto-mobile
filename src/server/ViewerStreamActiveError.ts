import { ActionableError } from "../models/ActionableError";

/** Typed, secret-free refusal to silently inherit another session's viewer parameters. */
export class ViewerStreamActiveError extends ActionableError {
  readonly code = "viewer_stream_active";
  constructor({ differingKeys }: { differingKeys: readonly string[] }) {
    super(
      `A viewer stream (read-only subscription held by another session) is active on this device with different parameters: ${differingKeys.join(", ")}. Call stop first, then start with the desired parameters.`,
    );
    this.name = "ViewerStreamActiveError";
  }
}
