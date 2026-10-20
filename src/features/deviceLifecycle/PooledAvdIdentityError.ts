import { ActionableError } from "../../models";

/**
 * An identity refusal raised from inside the shutdown path. It is an
 * {@link ActionableError} so it travels through `rethrowShutdownFailure`
 * unwrapped, and its own type lets `deleteDevice` report it as
 * `target_identity_unresolved` instead of a generic operation failure.
 */
export class PooledAvdIdentityError extends ActionableError {}
