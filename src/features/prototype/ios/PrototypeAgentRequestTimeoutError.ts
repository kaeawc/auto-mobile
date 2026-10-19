import { ActionableError } from "../../../models/ActionableError";
import type { PrototypeAgentRequestType } from "./prototypeAgentClient";

export class PrototypeAgentRequestTimeoutError extends ActionableError {
  constructor(
    readonly requestType: PrototypeAgentRequestType,
    readonly timeoutMs: number,
  ) {
    super(`Prototype agent did not answer ${requestType} within ${timeoutMs} ms.`);
    this.name = "PrototypeAgentRequestTimeoutError";
  }
}
