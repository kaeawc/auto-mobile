import { ActionableError } from "../../models";

export const PACKAGE_NOT_INSTALLED_ERROR = "App is not installed";

/** Raised inside the launch action when a live read shows the package was removed (#10192). */
export class LaunchPackageRemovedError extends ActionableError {
  constructor() {
    super(PACKAGE_NOT_INSTALLED_ERROR);
  }
}
