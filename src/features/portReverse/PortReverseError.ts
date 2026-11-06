import { ActionableError } from "../../models/ActionableError";

export type PortReverseErrorCode =
  | "port_reverse_conflict"
  | "port_reverse_not_owned"
  | "port_reverse_port_refused"
  | "port_reverse_reclaim_failed";

/**
 * Who holds a conflicting device port. `other_session`: another live AutoMobile session owns it.
 * `external_live`: made outside AutoMobile (or by a session no longer running) and its host target
 * accepts connections. `external_unknown`: made outside AutoMobile and its host target was not
 * shown to be live (it refused, is not `tcp:`, or could not be checked).
 */
export type PortReverseConflictKind = "other_session" | "external_live" | "external_unknown";

/** One conflicting device port; `conflictKind` is absent when the clash is the caller's own. */
export interface PortReverseConflict {
  devicePort: number;
  conflictKind?: PortReverseConflictKind;
}

export interface PortReverseErrorPayload {
  errorCode: PortReverseErrorCode;
  ports: number[];
  conflicts?: PortReverseConflict[];
  conflictKind?: PortReverseConflictKind;
}

/** A portReverse request AutoMobile refused; the device's mappings are left as they were. */
export class PortReverseError extends ActionableError {
  constructor(
    readonly code: PortReverseErrorCode,
    message: string,
    readonly ports: readonly number[],
    readonly conflicts: readonly PortReverseConflict[] = [],
  ) {
    super(message);
    this.name = "PortReverseError";
  }

  /** `conflictKind` is set when every conflicting port has the same kind. */
  toPayload(): PortReverseErrorPayload {
    const payload: PortReverseErrorPayload = { errorCode: this.code, ports: [...this.ports] };
    if (this.conflicts.length === 0) {
      return payload;
    }
    const kinds = new Set(this.conflicts.map((conflict) => conflict.conflictKind));
    const [only] = [...kinds];
    return {
      ...payload,
      conflicts: this.conflicts.map((conflict) => ({ ...conflict })),
      ...(kinds.size === 1 && only !== undefined ? { conflictKind: only } : {}),
    };
  }
}
