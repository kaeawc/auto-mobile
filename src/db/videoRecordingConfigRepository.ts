import type { Kysely } from "kysely";
import type { VideoRecordingConfig } from "../models";
import type { Database } from "./types";
import { KeyedJsonConfigRepository } from "./keyedJsonConfigRepository";

export class VideoRecordingConfigRepository extends KeyedJsonConfigRepository<VideoRecordingConfig> {
  constructor(db?: Kysely<Database>) {
    super({
      tableName: "video_recording_configs",
      loggerTag: "VideoRecordingConfigRepository",
      db,
    });
  }
}
