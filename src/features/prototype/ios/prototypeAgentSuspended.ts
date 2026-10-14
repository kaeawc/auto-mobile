import { ActionableError } from "../../../models/ActionableError";

export const IOS_PROTOTYPE_STATUS_TIMEOUT_MS = 3000;

/** A silent status request most likely means iOS suspended the app and its injected agent. */
export class PrototypeAgentSuspendedError extends ActionableError {
  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `Prototype agent did not answer get_prototype_status within ${timeoutMs} ms. ` +
        "iOS suspends an app that is not in the foreground, and the prototype agent injected into it, " +
        "so the prototype's app is most likely in the background. Bring that app back to the foreground " +
        "with launchApp (the prototype returns with its state), then retry.",
      options,
    );
    this.name = "PrototypeAgentSuspendedError";
  }
}
