import type { Kysely } from "kysely";
import type { IdGenerator } from "../utils/IdGenerator";
import type { Timer } from "../utils/SystemTimer";
import type { Database } from "./types";

/**
 * What a repository can be given in place of its defaults: the database (else the shared one,
 * resolved lazily), the clock and the id source. Each repository takes the fields it uses.
 */
export interface RepositoryDeps {
  readonly db?: Kysely<Database>;
  readonly timer?: Timer;
  readonly idGenerator?: IdGenerator;
}
