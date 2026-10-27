import { ActionableError } from "../../../models/ActionableError";

export class PrototypeAgentFrameTooLargeError extends ActionableError {
  constructor(readonly limitBytes: number) {
    super(
      `Prototype agent response frame exceeded ${limitBytes} bytes; the connection was closed. ` +
        "Relaunch the app with prototype injection; the agent build may not match this host.",
    );
    this.name = "PrototypeAgentFrameTooLargeError";
  }
}
