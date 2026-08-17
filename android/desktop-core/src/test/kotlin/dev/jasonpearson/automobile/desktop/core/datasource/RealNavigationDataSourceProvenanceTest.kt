package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers [RealNavigationDataSource.getNavigationGraph] parsing of the additive per-node/edge
 * provenance fields (nav (app,build) Phase 2, #4985), including backward-compatibility with a
 * pre-provenance daemon that omits them.
 */
class RealNavigationDataSourceProvenanceTest {

  private val graphUri = "automobile:navigation/graph?appId=com.example.app"

  @Test
  fun `parses node and edge provenance records`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      graphUri,
      """
      {
        "appId": "com.example.app",
        "nodes": [
          {
            "id": 1,
            "screenName": "Home",
            "visitCount": 3,
            "provenance": [
              {
                "buildKey": { "packageId": "com.example.app", "versionCode": 2, "contentHash": "hashB" },
                "deviceId": "emulator-5554",
                "sessionUuid": "session-1",
                "lastSeen": 250
              }
            ]
          }
        ],
        "edges": [
          {
            "id": 10,
            "from": "Home",
            "to": "Details",
            "toolName": "tapOn",
            "traversalCount": 2,
            "provenance": [
              {
                "buildKey": { "packageId": "com.example.app", "versionCode": 1, "contentHash": "hashA" },
                "deviceId": "emulator-9999",
                "sessionUuid": "session-2",
                "lastSeen": 400
              }
            ]
          }
        ],
        "currentScreen": "Home"
      }
      """
        .trimIndent(),
    )
    val source = RealNavigationDataSource(clientProvider = { client }, appId = "com.example.app")

    val result = source.getNavigationGraph()

    assertTrue(result is Result.Success)
    val graph = (result as Result.Success).data
    val home = graph.screens.first { it.name == "Home" }
    assertEquals(1, home.provenance.size)
    assertEquals("emulator-5554", home.provenance[0].deviceId)
    assertEquals(2, home.provenance[0].buildKey.versionCode)
    assertEquals("hashB", home.provenance[0].buildKey.contentHash)
    assertEquals(250L, home.provenance[0].lastSeen)

    val edge = graph.transitions.first()
    assertEquals(1, edge.provenance.size)
    assertEquals("emulator-9999", edge.provenance[0].deviceId)
    assertEquals("session-2", edge.provenance[0].sessionUuid)
  }

  @Test
  fun `defaults provenance to empty for a pre-provenance daemon`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      graphUri,
      """
      {
        "appId": "com.example.app",
        "nodes": [ { "id": 1, "screenName": "Home", "visitCount": 1 } ],
        "edges": [ { "id": 10, "from": "Home", "to": "Details", "toolName": "tapOn", "traversalCount": 1 } ],
        "currentScreen": "Home"
      }
      """
        .trimIndent(),
    )
    val source = RealNavigationDataSource(clientProvider = { client }, appId = "com.example.app")

    val result = source.getNavigationGraph()

    assertTrue(result is Result.Success)
    val graph = (result as Result.Success).data
    assertTrue(graph.screens.first().provenance.isEmpty())
    assertTrue(graph.transitions.first().provenance.isEmpty())
  }
}
