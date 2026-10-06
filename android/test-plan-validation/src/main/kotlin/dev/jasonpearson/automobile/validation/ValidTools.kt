package dev.jasonpearson.automobile.validation

/**
 * Tool names accepted in plan YAML `tool:` steps.
 *
 * The current tool names are not maintained here. The build's `generatePlanToolNames` task reads
 * every `name` in `schemas/tool-definitions.json` into the bundled `plan-tool-names.txt` resource,
 * so the allowlist follows the tool registry by construction and the published artifact does not
 * need the repository at runtime. The catalog includes hidden tools the daemon still runs as plan
 * steps (`startDevice`). The daemon applies no static allowlist of its own (an unknown tool is
 * reported by the plan executor), so no tool in the schema is excluded.
 */
object ValidTools {
  /**
   * Legacy tool names the daemon's `PlanMigrator.migrateToolName` rewrites to a current tool before
   * a plan runs, so a plan that still uses them is accepted by the daemon. They are not in
   * `schemas/tool-definitions.json`; keep this set in step with that migrator.
   */
  val MIGRATED_LEGACY_TOOLS =
    setOf("clearText", "imeAction", "inputText", "scroll", "swipeOnScreen", "tapOnText")

  /** Every name a plan step may use: the current tools plus [MIGRATED_LEGACY_TOOLS]. */
  val TOOLS: Set<String> by lazy { currentToolNames() + MIGRATED_LEGACY_TOOLS }

  /** Plan-level fields kept only for old plans; `description` and step `appId` are current. */
  val TOP_LEVEL_DEPRECATED_FIELDS = setOf("generated", "appId", "parameters")

  /** Step-level fields kept only for old plans (use `label` instead of `description`). */
  val STEP_DEPRECATED_FIELDS = setOf("description")

  val DEPRECATED_FIELDS = TOP_LEVEL_DEPRECATED_FIELDS + STEP_DEPRECATED_FIELDS

  private const val TOOL_NAMES_RESOURCE = "plan-tool-names.txt"

  private fun currentToolNames(): Set<String> {
    val stream =
      ValidTools::class.java.getResourceAsStream(TOOL_NAMES_RESOURCE)
        ?: throw IllegalStateException(
          "Could not find $TOOL_NAMES_RESOURCE in classpath resources. It is generated from " +
            "schemas/tool-definitions.json by the generatePlanToolNames Gradle task."
        )
    val names = stream.bufferedReader().use { it.readLines() }.filter { it.isNotBlank() }.toSet()
    check(names.isNotEmpty()) { "$TOOL_NAMES_RESOURCE is empty" }
    return names
  }
}
