import { generateDaemonHttpToken, type DaemonHttpTokenStore } from "../daemonHttpToken";
import type { IdGenerator } from "../../utils/IdGenerator";
import { ActionableError } from "../../models/ActionableError";

/** Retains this daemon's credential store and publication ownership across lifecycle steps. */
export class DaemonHttpTokenLifecycle {
  private published = false;

  constructor(
    private readonly store: DaemonHttpTokenStore,
    private readonly idGenerator: IdGenerator | undefined,
    private token = "",
  ) {}

  get isPublished(): boolean {
    return this.published;
  }

  get value(): string {
    return this.token;
  }

  prepare(): void {
    this.published = false;
    this.token = generateDaemonHttpToken(this.idGenerator);
  }

  publish(): void {
    if (!this.token) {
      throw new ActionableError("Daemon HTTP token is not configured");
    }
    this.store.write(this.token);
    this.published = true;
  }

  remove(): void {
    if (this.published) {
      this.store.remove();
      this.published = false;
    }
    this.token = "";
  }
}
