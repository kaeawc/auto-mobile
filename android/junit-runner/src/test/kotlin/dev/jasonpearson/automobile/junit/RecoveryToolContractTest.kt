package dev.jasonpearson.automobile.junit

import com.networknt.schema.InputFormat
import com.networknt.schema.Schema
import com.networknt.schema.SchemaRegistry
import com.networknt.schema.SpecificationVersion
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test

/**
 * Contract between the recovery agent's tools and the real tool surface (#10089). The agent called
 * `sendText`, `scroll`, `swipeOnScreen`, `doubleTapOn` and `longPressOn` (none exist) and passed
 * parameters the strict schemas reject, so every such call failed at the daemon. This loads the
 * repository's `schemas/tool-definitions.json` and fails when any call a tool makes names a tool
 * the schema does not define or carries parameters that do not validate against its `inputSchema`.
 */
class RecoveryToolContractTest {

  private data class Call(val tool: String, val parameters: Map<String, Any>)

  private class CapturingClient : AutoMobileAgent.MCPClient {
    val calls = mutableListOf<Call>()

    override fun isConnected() = true

    override fun connect(serverUrl: String) = Unit

    override fun disconnect() = Unit

    override fun callTool(toolName: String, parameters: Map<String, Any>): String {
      calls += Call(toolName, parameters)
      return """{"content":[{"type":"text","text":"Settings"}]}"""
    }

    override fun listAvailableTools() = emptyList<AutoMobileAgent.MCPToolDefinition>()
  }

  private val schemas: Map<String, Schema> by lazy {
    val registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
    Json.parseToJsonElement(schemaFile().readText()).jsonArray.associate { entry ->
      val tool = entry.jsonObject
      tool.getValue("name").jsonPrimitive.content to
        registry.getSchema(tool.getValue("inputSchema").toString(), InputFormat.JSON)
    }
  }

  private fun schemaFile(): File {
    val configured = System.getProperty("automobile.daemon.local.project.path")
    val roots =
      listOfNotNull(configured?.let(::File)) +
        generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
    return roots.map { File(it, "schemas/tool-definitions.json") }.first { it.isFile }
  }

  private fun violations(call: Call): List<String> {
    val schema = schemas[call.tool] ?: return listOf("unknown tool '${call.tool}'")
    val arguments = JsonObject(call.parameters.mapValues { toJsonElement(it.value) })
    return schema.validate(arguments.toString(), InputFormat.JSON).map { "${call.tool}: $it" }
  }

  /** One or more realistic invocations per agent tool, keyed by the agent-facing tool name. */
  private fun cases(client: AutoMobileAgent.MCPClient): Map<String, List<suspend () -> Unit>> {
    return mapOf(
      "observe" to
        listOf(
          { AutoMobileAgent.ObserveTool(client).execute(AutoMobileAgent.ObserveTool.Args()) },
          {
            AutoMobileAgent.ObserveTool(client)
              .execute(AutoMobileAgent.ObserveTool.Args(raw = true))
          },
        ),
      "tapOn" to
        listOf(
          {
            AutoMobileAgent.TapOnTool(client).execute(AutoMobileAgent.TapOnTool.Args(text = "OK"))
          },
          {
            AutoMobileAgent.TapOnTool(client).execute(AutoMobileAgent.TapOnTool.Args(id = "a:id/b"))
          },
          {
            AutoMobileAgent.TapOnTool(client)
              .execute(AutoMobileAgent.TapOnTool.Args(x = 10, y = 20, action = "doubleTap"))
          },
          {
            AutoMobileAgent.TapOnTool(client)
              .execute(AutoMobileAgent.TapOnTool.Args(text = "OK", action = "longPress"))
          },
        ),
      "typeText" to
        listOf(
          {
            AutoMobileAgent.TypeTextTool(client).execute(AutoMobileAgent.TypeTextTool.Args("hi"))
          },
        ),
      "sendKeys" to
        listOf(
          {
            AutoMobileAgent.SendKeysTool(client)
              .execute(AutoMobileAgent.SendKeysTool.Args(action = "type", text = "hi"))
          },
          {
            AutoMobileAgent.SendKeysTool(client).execute(AutoMobileAgent.SendKeysTool.Args("clear"))
          },
          {
            AutoMobileAgent.SendKeysTool(client)
              .execute(AutoMobileAgent.SendKeysTool.Args(action = "key", key = "enter"))
          },
        ),
      "swipe" to
        listOf(
          { AutoMobileAgent.SwipeTool(client).execute(AutoMobileAgent.SwipeTool.Args()) },
          {
            AutoMobileAgent.SwipeTool(client)
              .execute(AutoMobileAgent.SwipeTool.Args("left", containerElementId = "a:id/list"))
          },
        ),
      "scroll" to
        listOf(
          {
            AutoMobileAgent.ScrollTool(client)
              .execute(AutoMobileAgent.ScrollTool.Args(containerElementId = "a:id/list"))
          },
          {
            AutoMobileAgent.ScrollTool(client)
              .execute(
                AutoMobileAgent.ScrollTool.Args("a:id/list", "down", lookForText = "Settings"),
              )
          },
          {
            AutoMobileAgent.ScrollTool(client)
              .execute(
                AutoMobileAgent.ScrollTool.Args(
                  "a:id/list",
                  "down",
                  lookForText = "Settings",
                  lookForElementId = "a:id/settings",
                ),
              )
          },
        ),
      "waitFor" to
        listOf(
          {
            // The capturing client's observe result contains the text, so the first poll matches.
            AutoMobileAgent.WaitForTool(client)
              .execute(AutoMobileAgent.WaitForTool.Args(text = "Settings"))
          },
        ),
      "goBack" to
        listOf({ AutoMobileAgent.GoBackTool(client).execute(AutoMobileAgent.GoBackTool.Args()) }),
      "pressButton" to
        listOf(
          {
            AutoMobileAgent.PressButtonTool(client)
              .execute(AutoMobileAgent.PressButtonTool.Args("home"))
          },
        ),
      "launchApp" to
        listOf(
          {
            AutoMobileAgent.LaunchAppTool(client).execute(AutoMobileAgent.LaunchAppTool.Args("a.b"))
          },
        ),
      "terminateApp" to
        listOf(
          {
            AutoMobileAgent.TerminateAppTool(client)
              .execute(AutoMobileAgent.TerminateAppTool.Args("a.b"))
          },
        ),
      "doubleTapOn" to
        listOf(
          {
            AutoMobileAgent.DoubleTapOnTool(client)
              .execute(AutoMobileAgent.DoubleTapOnTool.Args(1, 2))
          },
        ),
      "longPressOn" to
        listOf(
          {
            AutoMobileAgent.LongPressOnTool(client)
              .execute(AutoMobileAgent.LongPressOnTool.Args(text = "OK"))
          },
          {
            AutoMobileAgent.LongPressOnTool(client)
              .execute(AutoMobileAgent.LongPressOnTool.Args(x = 5, y = 6, duration = 100))
          },
        ),
    )
  }

  @Test
  fun `every agent tool has a contract case`() {
    val client = CapturingClient()
    val toolNames =
      AutoMobileAgent.AutoMobileMCPToolFactory(client).createAllTools().map { it.name }
    val covered = cases(client).filterValues { it.isNotEmpty() }.keys
    assertEquals(toolNames.toSet(), covered, "add a contract case for every tool the agent exposes")
  }

  @Test
  fun `every call an agent tool makes names a real tool with valid parameters`() {
    val client = CapturingClient()
    runBlocking { cases(client).values.flatten().forEach { it() } }

    assertTrue(client.calls.isNotEmpty())
    val problems = client.calls.flatMap(::violations)
    assertTrue(
      problems.isEmpty(),
      "tool calls that violate schemas/tool-definitions.json:\n" + problems.joinToString("\n"),
    )
  }

  @Test
  fun `a device-pinned observe still validates against the observe schema`() {
    // observe advertises deviceId; the pin turns a raw observe into project=full because the
    // daemon rejects raw on a sessionless deviceId read (#10089).
    val client = CapturingClient()
    val pinned = DevicePinningMCPClient(client, "emulator-5556")
    runBlocking {
      AutoMobileAgent.ObserveTool(pinned).execute(AutoMobileAgent.ObserveTool.Args())
      AutoMobileAgent.ObserveTool(pinned).execute(AutoMobileAgent.ObserveTool.Args(raw = true))
      AutoMobileAgent.WaitForTool(pinned)
        .execute(AutoMobileAgent.WaitForTool.Args(text = "Settings"))
    }

    assertEquals(3, client.calls.size)
    client.calls.forEach { assertEquals("emulator-5556", it.parameters["deviceId"]) }
    val problems = client.calls.flatMap(::violations)
    assertTrue(problems.isEmpty(), problems.joinToString("\n"))
  }

  @Test
  fun `the contract check rejects the pre-10089 call shapes`() {
    val legacy =
      listOf(
        Call("sendText", mapOf("text" to "hi")),
        Call("scroll", mapOf("containerElementId" to "a", "direction" to "up")),
        Call("swipeOnScreen", mapOf("direction" to "up")),
        Call("doubleTapOn", mapOf("x" to 1, "y" to 2)),
        Call("longPressOn", mapOf("x" to 1, "y" to 2)),
        Call("observe", mapOf("withViewHierarchy" to true, "includeInvisible" to false)),
        Call("tapOn", mapOf("text" to "OK")),
      )
    legacy.forEach { assertFalse(violations(it).isEmpty(), "expected ${it.tool} to be rejected") }
  }
}
