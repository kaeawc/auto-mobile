import { ActionableError } from "../../models/ActionableError";

export type PortReverseErrorCode =
  | "port_reverse_conflict"
  | "port_reverse_not_owned"
  | "port_reverse_port_refused";

/** A portReverse request AutoMobile refused; the device's mappings are left as they were. */
export class PortReverseError extends ActionableError {
  constructor(
    readonly code: PortReverseErrorCode,
    message: string,
    readonly ports: readonly number[],
  ) {
    super(message);
    this.name = "PortReverseError";
  }

  toPayload(): { errorCode: PortReverseErrorCode; ports: number[] } {
    return { errorCode: this.code, ports: [...this.ports] };
  }
}
