package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers [RealNavigationDataSource.listApps] against the locked `automobile:navigation/apps`
 * resource contract (issue #4910): `{ "apps":
 * [ { "appId", "displayName": null?, "lastUpdated": <ISO-8601> } ] }`, ordered newest-first.
 * Exercised with a [FakeAutoMobileClient] so no socket / MCP daemon is touched.
 */
class RealNavigationDataSourceListAppsTest {

  private val appsUri = "automobile:navigation/apps"

  @Test
  fun `parses apps preserving order and nullable displayName`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      appsUri,
      """
      {
        "apps": [
          { "appId": "com.example.shopping", "displayName": "Shopping", "lastUpdated": "2026-01-03T12:00:00.000Z" },
          { "appId": "com.example.banking", "displayName": null, "lastUpdated": "2026-01-01T09:30:00.000Z" }
        ]
      }
      """
        .trimIndent(),
    )
    val source = RealNavigationDataSource(clientProvider = { client })

    val result = source.listApps()

    assertTrue(result is Result.Success)
    val apps = (result as Result.Success).data
    assertEquals(2, apps.size)
    // Newest-first order is preserved.
    assertEquals("com.example.shopping", apps[0].appId)
    assertEquals("Shopping", apps[0].displayName)
    assertEquals("2026-01-03T12:00:00.000Z", apps[0].lastUpdated)
    assertEquals("com.example.banking", apps[1].appId)
    assertNull(apps[1].displayName)
  }

  @Test
  fun `returns empty success when no apps have a graph`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(appsUri, """{ "apps": [] }""")
    val source = RealNavigationDataSource(clientProvider = { client })

    val result = source.listApps()

    assertTrue(result is Result.Success)
    assertTrue((result as Result.Success).data.isEmpty())
  }

  @Test
  fun `returns empty success with no client provider`() = runBlocking {
    val source = RealNavigationDataSource(clientProvider = null)

    val result = source.listApps()

    assertTrue(result is Result.Success)
    assertTrue((result as Result.Success).data.isEmpty())
  }

  @Test
  fun `surfaces a typed error when the resource read throws`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.throwOnReadResource = RuntimeException("daemon down")
    val source = RealNavigationDataSource(clientProvider = { client })

    val result = source.listApps()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message.orEmpty().contains("daemon down"))
  }
}
