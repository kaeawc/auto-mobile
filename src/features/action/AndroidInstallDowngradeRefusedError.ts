import { ActionableError } from "../../models/ActionableError";

export const INSTALL_DOWNGRADE_REFUSED = "install_downgrade_refused";

/**
 * Android refused the install with INSTALL_FAILED_VERSION_DOWNGRADE and the caller did not opt into
 * the uninstall-and-reinstall recovery: the installed app, its UID and its data were left in place.
 */
export class AndroidInstallDowngradeRefusedError extends ActionableError {
  readonly code = INSTALL_DOWNGRADE_REFUSED;

  constructor(
    readonly packageName: string | undefined,
    { triedAllowDowngrade, cause }: { triedAllowDowngrade: boolean; cause?: unknown },
  ) {
    super(downgradeRefusedMessage(packageName, triedAllowDowngrade), { cause });
    this.name = "AndroidInstallDowngradeRefusedError";
  }
}

function downgradeRefusedMessage(packageName: string | undefined, triedAllowDowngrade: boolean) {
  const app = packageName ?? "the app";
  const inPlace = triedAllowDowngrade
    ? "The in-place downgrade (allowDowngrade: true, install -d) was also rejected; Android " +
      "allows it only for debuggable apps."
    : "To downgrade in place and keep app data, pass allowDowngrade: true (install -d; " +
      "debuggable apps only).";
  return (
    `[${INSTALL_DOWNGRADE_REFUSED}] The installed ${app} has a higher versionCode than the ` +
    `artifact and Android refused the downgrade (INSTALL_FAILED_VERSION_DOWNGRADE). The ` +
    `installed app and its data were left untouched. ${inPlace} To uninstall it first, ` +
    `deleting its app data, and install this build, pass allowDestructiveRecovery: true.`
  );
}
