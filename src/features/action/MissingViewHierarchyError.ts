import { ActionableError } from "../../models/ActionableError";

/**
 * An action could not run because no usable view hierarchy was available.
 * Typed so the tool boundary can tell this CtrlProxy-read symptom from other
 * failures and explain it with its real cause, such as a forwarding-lease
 * conflict (#10485).
 */
export class MissingViewHierarchyError extends ActionableError {
  constructor(options?: ErrorOptions) {
    super("Cannot perform action without view hierarchy", options);
    this.name = "MissingViewHierarchyError";
  }
}
