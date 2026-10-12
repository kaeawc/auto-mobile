import { type Kysely, sql } from "kysely";

// #11933: preserve the destination row when both spellings already exist.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM feature_flags WHERE key = 'mcp-recording'
    AND EXISTS (SELECT 1 FROM feature_flags WHERE key = 'tool-call-recording')`.execute(db);
  await sql`UPDATE feature_flags SET key = 'tool-call-recording'
    WHERE key = 'mcp-recording'`.execute(db);

  await sql`DELETE FROM session_tool_overrides WHERE tool_name = 'recordSteps'
    AND EXISTS (SELECT 1 FROM session_tool_overrides AS destination
      WHERE destination.session_uuid = session_tool_overrides.session_uuid
        AND destination.tool_name = 'recordToolCalls')`.execute(db);
  await sql`UPDATE session_tool_overrides SET tool_name = 'recordToolCalls'
    WHERE tool_name = 'recordSteps'`.execute(db);

  await sql`DELETE FROM session_tool_overrides WHERE tool_name = 'startTestRecording'
    AND EXISTS (SELECT 1 FROM session_tool_overrides AS destination
      WHERE destination.session_uuid = session_tool_overrides.session_uuid
        AND destination.tool_name = 'recordDeviceGestures')`.execute(db);
  await sql`UPDATE session_tool_overrides SET tool_name = 'recordDeviceGestures'
    WHERE tool_name = 'startTestRecording'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM feature_flags WHERE key = 'tool-call-recording'
    AND EXISTS (SELECT 1 FROM feature_flags WHERE key = 'mcp-recording')`.execute(db);
  await sql`UPDATE feature_flags SET key = 'mcp-recording'
    WHERE key = 'tool-call-recording'`.execute(db);

  await sql`DELETE FROM session_tool_overrides WHERE tool_name = 'recordToolCalls'
    AND EXISTS (SELECT 1 FROM session_tool_overrides AS destination
      WHERE destination.session_uuid = session_tool_overrides.session_uuid
        AND destination.tool_name = 'recordSteps')`.execute(db);
  await sql`UPDATE session_tool_overrides SET tool_name = 'recordSteps'
    WHERE tool_name = 'recordToolCalls'`.execute(db);

  await sql`DELETE FROM session_tool_overrides WHERE tool_name = 'recordDeviceGestures'
    AND EXISTS (SELECT 1 FROM session_tool_overrides AS destination
      WHERE destination.session_uuid = session_tool_overrides.session_uuid
        AND destination.tool_name = 'startTestRecording')`.execute(db);
  await sql`UPDATE session_tool_overrides SET tool_name = 'startTestRecording'
    WHERE tool_name = 'recordDeviceGestures'`.execute(db);
}
