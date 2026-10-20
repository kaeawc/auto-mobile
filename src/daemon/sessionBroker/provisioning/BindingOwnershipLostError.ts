import { SessionReleasedDuringCallError } from "../../sessionReleasedDuringCall";

export class BindingOwnershipLostError extends SessionReleasedDuringCallError {
  constructor(sessionUuid: string) {
    super(sessionUuid, "binding-ownership-lost");
    this.message = `Session ${sessionUuid} is terminal after binding-ownership-lost and cannot be reused. Acquire a new device with getAndroid or getApple.`;
    this.name = "BindingOwnershipLostError";
  }
}
