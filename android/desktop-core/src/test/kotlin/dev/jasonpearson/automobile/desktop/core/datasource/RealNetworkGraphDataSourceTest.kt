package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RealNetworkGraphDataSourceTest {

  /** Wraps tool-result JSON the way the MCP tool-response envelope does. */
  private fun toolResponse(bodyJson: String): JsonElement = buildJsonObject {
    put(
      "content",
      buildJsonArray {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", bodyJson)
          }
        )
      },
    )
  }

  private val hostArrayJson =
    """
    [
      {
        "scheme": "https",
        "host": "api.example.com",
        "paths": {
          "users[GET]": {"method":"GET","type":"application/json","success":3,"errors":1,"p50":10,"p95":20}
        }
      }
    ]
    """
      .trimIndent()

  @Test
  fun `returns error when no clientProvider`() = runBlocking {
    val result = RealNetworkGraphDataSource().getNetworkGraph()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("Not connected"))
  }

  @Test
  fun `returns error when no deviceId`() = runBlocking {
    val client = FakeAutoMobileClient()
    val result =
      RealNetworkGraphDataSource(clientProvider = { client }, deviceId = null).getNetworkGraph()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("device"))
  }

  @Test
  fun `decodes an inline graph and forwards deviceId plus filters`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.callToolResult = toolResponse("""{"graph": $hostArrayJson}""")
    var capturedArgs: JsonObject? = null
    val capturing =
      object : AutoMobileClient by client {
        override fun callTool(name: String, arguments: JsonObject): JsonElement {
          capturedArgs = arguments
          return client.callToolResult
        }
      }

    val result =
      RealNetworkGraphDataSource(
          clientProvider = { capturing },
          deviceId = "emulator-5554",
          sinceSeconds = 60,
          minRequests = 2,
        )
        .getNetworkGraph()

    assertTrue(result is Result.Success)
    val rows = (result as Result.Success).data
    assertEquals(1, rows.size)
    assertEquals("api.example.com", rows.first().host)
    assertEquals("/users", rows.first().path)
    assertEquals("GET", rows.first().method)
    assertEquals(3, rows.first().success)

    val args = capturedArgs!!
    assertEquals("emulator-5554", args.getValue("deviceId").jsonPrimitive.content)
    assertEquals(60, args.getValue("sinceSeconds").jsonPrimitive.int)
    assertEquals(2, args.getValue("minRequests").jsonPrimitive.int)
  }

  @Test
  fun `resolves the artifacted graph by reading the artifact file`() = runBlocking {
    val client = FakeAutoMobileClient()
    // External calls artifact the array away; the response carries only a file reference.
    client.callToolResult =
      toolResponse(
        """
        {
          "graph": {"artifact": {"path": "/tmp/auto-mobile/getNetworkGraph-1.json", "format": "json", "payload": "NetworkGraph", "bytes": 123, "tool": "getNetworkGraph"}},
          "graphSummary": {"hostCount": 1}
        }
        """
          .trimIndent()
      )
    var requestedPath: String? = null

    val result =
      RealNetworkGraphDataSource(
          clientProvider = { client },
          deviceId = "emulator-5554",
          readArtifactFile = { path ->
            requestedPath = path
            hostArrayJson
          },
        )
        .getNetworkGraph()

    assertTrue(result is Result.Success)
    assertEquals("/tmp/auto-mobile/getNetworkGraph-1.json", requestedPath)
    val rows = (result as Result.Success).data
    assertEquals(1, rows.size)
    assertEquals("/users", rows.first().path)
  }

  @Test
  fun `an artifacted empty graph resolves to no rows`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.callToolResult =
      toolResponse(
        """{"graph": {"artifact": {"path": "/tmp/empty.json"}}, "graphSummary": {"hostCount": 0}}"""
      )

    val result =
      RealNetworkGraphDataSource(
          clientProvider = { client },
          deviceId = "emulator-5554",
          readArtifactFile = { "[]" },
        )
        .getNetworkGraph()

    assertTrue(result is Result.Success)
    assertTrue((result as Result.Success).data.isEmpty())
  }

  @Test
  fun `returns error when the artifact reference has no path`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.callToolResult = toolResponse("""{"graph": {"artifact": {"format": "json"}}}""")

    val result =
      RealNetworkGraphDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getNetworkGraph()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("artifact path"))
  }

  @Test
  fun `returns error when the artifact file cannot be read`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.callToolResult =
      toolResponse("""{"graph": {"artifact": {"path": "/tmp/missing.json"}}}""")

    val result =
      RealNetworkGraphDataSource(
          clientProvider = { client },
          deviceId = "emulator-5554",
          readArtifactFile = { throw java.io.IOException("no such file") },
        )
        .getNetworkGraph()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("Failed to load network graph"))
  }
}
