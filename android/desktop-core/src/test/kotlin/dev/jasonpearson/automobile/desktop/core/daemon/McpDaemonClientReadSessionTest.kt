package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * #11364: the IDE sends its reads through the desktop session's own [McpDaemonClient], which named
 * its `sessionUuid` on every call. A read then failed with that session's terminal error between a
 * release and the rotation. Reads go out with no session; device controls still name it.
 */
class McpDaemonClientReadSessionTest {
  private val sent = mutableListOf<Pair<String, JsonObject>>()
  private val allocations = mutableListOf<String>()

  private val client =
    InputAllocatingClient(
      McpDaemonClient(
        DaemonRequestTransport { request ->
          val name = (request.params["name"] as JsonPrimitive).content
          sent += name to (request.params["arguments"] as JsonObject)
          DaemonJson.decodeFromString<DaemonResponse>(
            """{"id":"${request.id}","type":"mcp_response","success":true,""" +
              """"result":{"content":[{"type":"text","text":"{}"}]}}""",
          )
        },
        sessionUuid = DESKTOP_SESSION,
      ),
      DesktopInputAllocation { deviceId ->
        allocations += deviceId
        true
      },
      sessionUuidProvider = { DESKTOP_SESSION },
    )

  private fun sessionSent(name: String): String? =
    (sent.single { it.first == name }.second["sessionUuid"] as? JsonPrimitive)?.content

  @Test
  fun `observe and a SELECT go out with no session while a tap still names the desktop session`() {
    client.callTool("observe", buildJsonObject { put("deviceId", DEVICE) })
    client.callTool(
      "sqlQuery",
      buildJsonObject {
        put("deviceId", DEVICE)
        put("query", "SELECT * FROM users")
      },
    )
    client.callTool("tapOn", buildJsonObject { put("deviceId", DEVICE) })

    assertEquals(null, sessionSent("observe"))
    assertEquals(null, sessionSent("sqlQuery"))
    assertEquals(DESKTOP_SESSION, sessionSent("tapOn"))
    // Only the device control allocates; the reads only watch.
    assertEquals(listOf(DEVICE), allocations)
  }

  @Test
  fun `a write query still names the desktop session`() {
    client.callTool(
      "sqlQuery",
      buildJsonObject {
        put("deviceId", DEVICE)
        put("query", "DELETE FROM users")
      },
    )

    assertEquals(DESKTOP_SESSION, sessionSent("sqlQuery"))
  }

  private companion object {
    const val DESKTOP_SESSION = "desk-1"
    const val DEVICE = "emulator-5554"
  }
}
