import { ActionableError } from "../models";
import type { StageSessionDownloadsRefusalCode } from "./downloadsFixtureContract";

/**
 * Refuses a session-scoped Downloads-staging request before any device access.
 * Carries the same code vocabulary as the session-log resource family so a
 * caller that does not own a live session learns nothing about the device and
 * no device client is ever constructed on refusal.
 */
export class StageSessionDownloadsRefusal extends ActionableError {
  constructor(
    readonly code: StageSessionDownloadsRefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "StageSessionDownloadsRefusal";
  }
}
