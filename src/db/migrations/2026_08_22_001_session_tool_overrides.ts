import { type Kysely, sql } from "kysely";

const TOOLS_BY_LEGACY_CAPABILITY: Readonly<Record<string, readonly string[]>> = {
  clipboard: ["clipboard", "selectAllText"],
  "advanced-interaction": ["openLink", "imeAction", "dragAndDrop", "pinchOn", "shake", "rotate"],
  "app-permissions": ["getAppPermissions", "setAppPermissions"],
  "device-settings": ["changeLocalization", "getDeviceState", "setDeviceState"],
  "device-control": ["provisionDevice"],
  "app-data-interop": [
    "putAppFile",
    "getPreference",
    "setPreference",
    "sqlQuery",
    "setKeyValue",
    "removeKeyValue",
    "clearKeyValueFile",
  ],
  notifications: [
    "systemTray",
    "postNotification",
    "getNotificationPolicy",
    "setNotificationPolicy",
  ],
  telephony: ["phoneCall", "sendSms"],
  "accessibility-tools": ["accessibility", "accessibilityFocus"],
  "screen-artifacts": ["videoRecording", "deviceSnapshot", "highlight"],
  "test-authoring": [
    "executePlan",
    "startTestRecording",
    "exportPlan",
    "recordSteps",
    "barrier",
    "criticalSection",
  ],
  "network-inspection": ["network", "mockNetwork", "clearMockNetwork", "getNetworkGraph"],
  "app-routing": ["getDeepLinks"],
  "navigation-modeling": ["navigateTo", "getNavigationGraph", "explore"],
  "biometric-auth": ["biometricAuth"],
};

interface LegacyCapabilityRow {
  session_uuid: string;
  capability: string;
  enabled: number;
  updated_at: string;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("session_tool_overrides")
    .ifNotExists()
    .addColumn("session_uuid", "text", (column) => column.notNull())
    .addColumn("tool_name", "text", (column) => column.notNull())
    .addColumn("enabled", "integer", (column) => column.notNull())
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .addPrimaryKeyConstraint("session_tool_overrides_pk", ["session_uuid", "tool_name"])
    .execute();

  const oldTable = await sql<{ name: string }>`
    select name from sqlite_master
    where type = 'table' and name = 'session_tool_capabilities'
  `.execute(db);
  if (oldTable.rows.length === 0) {
    return;
  }

  const legacyRows = await sql<LegacyCapabilityRow>`
    select session_uuid, capability, enabled, updated_at
    from session_tool_capabilities
  `.execute(db);
  for (const row of legacyRows.rows) {
    for (const toolName of TOOLS_BY_LEGACY_CAPABILITY[row.capability] ?? []) {
      await sql`
        insert into session_tool_overrides (
          session_uuid,
          tool_name,
          enabled,
          updated_at
        ) values (
          ${row.session_uuid},
          ${toolName},
          ${row.enabled},
          ${row.updated_at}
        )
        on conflict(session_uuid, tool_name) do update set
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `.execute(db);
    }
  }

  await db.schema.dropTable("session_tool_capabilities").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("session_tool_capabilities")
    .ifNotExists()
    .addColumn("session_uuid", "text", (column) => column.notNull())
    .addColumn("capability", "text", (column) => column.notNull())
    .addColumn("enabled", "integer", (column) => column.notNull())
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .addPrimaryKeyConstraint("session_tool_capabilities_pk", ["session_uuid", "capability"])
    .execute();
  await db.schema.dropTable("session_tool_overrides").ifExists().execute();
}
