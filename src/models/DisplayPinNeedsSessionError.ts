import { ActionableError } from "./ActionableError";

export class DisplayPinNeedsSessionError extends ActionableError {
  constructor() {
    super(
      "A display pin requires an initialized daemon device session. Acquire a session, then call setActiveDevice with sessionUuid and display; display pins are unsupported in direct mode.",
    );
    this.name = "DisplayPinNeedsSessionError";
  }
}
