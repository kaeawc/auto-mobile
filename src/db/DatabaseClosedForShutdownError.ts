import { ActionableError } from "../models/ActionableError";

/**
 * A query, transaction or migration wait that reached the database after graceful shutdown had
 * closed it. The work is refused: nothing is written and the database is not reopened.
 */
export class DatabaseClosedForShutdownError extends ActionableError {}
