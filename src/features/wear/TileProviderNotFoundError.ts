import { ActionableError } from "../../models/ActionableError";
import { TILE_PROVIDER_ACTION } from "./tileProviderAction";

/** A component that is not an installed, exported Wear tile provider service. */
export class TileProviderNotFoundError extends ActionableError {
  readonly reason = "providerNotFound" as const;

  constructor(
    readonly component: string,
    readonly available: string[],
  ) {
    super(
      `'${component}' is not a Wear tile provider on this device. ` +
        (available.length > 0
          ? `Use one of: ${available.join(", ")}.`
          : "No tile providers are installed; install an app that declares a service for " +
            `${TILE_PROVIDER_ACTION}.`),
    );
  }
}
