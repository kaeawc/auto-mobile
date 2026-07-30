package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceContent
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RealNetworkRequestsDataSourceTest {

  private val trafficJson =
    """
    {
      "events": [
        {
          "id": 7,
          "timestamp": 1000,
          "method": "GET",
          "url": "https://api.example.com/users/42",
          "host": "api.example.com",
          "path": "/users/42",
          "statusCode": 200,
          "durationMs": 34,
          "contentType": "application/json",
          "error": null
        },
        {
          "id": 8,
          "timestamp": 900,
          "method": "POST",
          "url": "https://api.example.com/login",
          "host": "api.example.com",
          "path": "/login",
          "statusCode": 500,
          "durationMs": 812,
          "contentType": null,
          "error": "boom"
        }
      ],
      "count": 2,
      "hasMore": false
    }
    """
      .trimIndent()

  private val detailJson =
    """
    {
      "id": 7,
      "timestamp": 1000,
      "method": "GET",
      "url": "https://api.example.com/users/42",
      "statusCode": 200,
      "durationMs": 34,
      "host": "api.example.com",
      "path": "/users/42",
      "protocol": "h2",
      "contentType": "application/json",
      "requestHeaders": {"accept": "application/json"},
      "responseHeaders": {"content-type": "application/json", "x-cache": "HIT"}
    }
    """
      .trimIndent()

  @Test
  fun `returns error when no clientProvider`() = runBlocking {
    val result = RealNetworkRequestsDataSource().getRequests()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("Not connected"))
  }

  @Test
  fun `returns error when no deviceId`() = runBlocking {
    val client = FakeAutoMobileClient()
    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = null).getRequests()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("device"))
  }

  @Test
  fun `parses traffic events into rows and scopes the read to the deviceId`() = runBlocking {
    var capturedUri: String? = null
    val client =
      object : AutoMobileClient by FakeAutoMobileClient() {
        override fun readResource(uri: String): List<McpResourceContent> {
          capturedUri = uri
          return listOf(
            McpResourceContent(uri = uri, mimeType = "application/json", text = trafficJson)
          )
        }
      }

    val result =
      RealNetworkRequestsDataSource(
          clientProvider = { client },
          deviceId = "emulator-5554",
          limit = 25,
        )
        .getRequests()

    assertTrue(result is Result.Success)
    val rows = (result as Result.Success).data
    assertEquals(2, rows.size)
    assertEquals(7L, rows.first().id)
    assertEquals("GET", rows.first().method)
    assertEquals("api.example.com", rows.first().host)
    assertEquals("/users/42", rows.first().path)
    assertEquals(200, rows.first().statusCode)
    assertEquals(34L, rows.first().durationMs)
    assertEquals(500, rows[1].statusCode)
    assertEquals("boom", rows[1].error)

    // Scoped to device; limit precedes deviceId to match the daemon's template key order.
    assertEquals("automobile:network/traffic?limit=25&deviceId=emulator-5554", capturedUri)
  }

  @Test
  fun `missing host and path coalesce to empty strings`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      "automobile:network/traffic?limit=50&deviceId=emulator-5554",
      """{"events":[{"id":1,"method":"GET","statusCode":204,"durationMs":5}],"count":1}""",
    )

    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getRequests()

    assertTrue(result is Result.Success)
    val row = (result as Result.Success).data.single()
    assertEquals("", row.host)
    assertEquals("", row.path)
    assertEquals(null, row.contentType)
  }

  @Test
  fun `an empty traffic log resolves to no rows`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      "automobile:network/traffic?limit=50&deviceId=emulator-5554",
      """{"events":[],"count":0,"hasMore":false}""",
    )

    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getRequests()

    assertTrue(result is Result.Success)
    assertTrue((result as Result.Success).data.isEmpty())
  }

  @Test
  fun `surfaces an error field from the traffic response as a failure`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      "automobile:network/traffic?limit=50&deviceId=emulator-5554",
      """{"error":"Failed to query traffic: db locked"}""",
    )

    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getRequests()

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("db locked"))
  }

  @Test
  fun `an empty resource response resolves to no rows`() = runBlocking {
    val client = FakeAutoMobileClient() // no response registered -> empty content list

    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getRequests()

    assertTrue(result is Result.Success)
    assertTrue((result as Result.Success).data.isEmpty())
  }

  @Test
  fun `getRequestDetail parses headers and timing`() = runBlocking {
    var capturedUri: String? = null
    val client =
      object : AutoMobileClient by FakeAutoMobileClient() {
        override fun readResource(uri: String): List<McpResourceContent> {
          capturedUri = uri
          return listOf(
            McpResourceContent(uri = uri, mimeType = "application/json", text = detailJson)
          )
        }
      }

    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getRequestDetail(7)

    assertTrue(result is Result.Success)
    val detail = (result as Result.Success).data
    assertEquals(7L, detail.id)
    assertEquals("h2", detail.protocol)
    assertEquals("application/json", detail.requestHeaders["accept"])
    assertEquals("HIT", detail.responseHeaders["x-cache"])
    assertEquals("automobile:network/request/7", capturedUri)
  }

  @Test
  fun `getRequestDetail coalesces absent header maps to empty`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      "automobile:network/request/9",
      """{"id":9,"method":"GET","url":"https://x/y","host":"x","path":"/y","statusCode":200,"durationMs":1}""",
    )

    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getRequestDetail(9)

    assertTrue(result is Result.Success)
    val detail = (result as Result.Success).data
    assertTrue(detail.requestHeaders.isEmpty())
    assertTrue(detail.responseHeaders.isEmpty())
  }

  @Test
  fun `getRequestDetail treats the no-id not-found envelope as a failure`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      "automobile:network/request/404",
      """{"error":"Network request 404 not found"}""",
    )

    val result =
      RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
        .getRequestDetail(404)

    assertTrue(result is Result.Error)
    assertTrue((result as Result.Error).message!!.contains("not found"))
  }

  @Test
  fun `getRequestDetail returns error when no clientProvider`() = runBlocking {
    val result = RealNetworkRequestsDataSource().getRequestDetail(1)

    assertTrue(result is Result.Error)
    assertFalse((result as Result.Error).message.isNullOrBlank())
  }

  @Test
  fun `a fractional durationMs decodes into a row instead of failing the whole table`() =
    runBlocking {
      // iOS captures serialize a fractional durationMs (and timestamp); a Long wire field would
      // throw on the whole payload and hide every row. It must decode and round for display.
      val client = FakeAutoMobileClient()
      client.setResourceResponseWithText(
        "automobile:network/traffic?limit=50&deviceId=emulator-5554",
        """{"events":[{"id":3,"timestamp":1000.5,"method":"GET","host":"h","path":"/p","statusCode":200,"durationMs":34.125}],"count":1}""",
      )

      val result =
        RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
          .getRequests()

      assertTrue(result is Result.Success)
      val row = (result as Result.Success).data.single()
      assertEquals(3L, row.id)
      assertEquals(34L, row.durationMs)
      assertEquals(1001L, row.timestamp)
    }

  @Test
  fun `getRequestDetail on a transport-failed request returns the detail with its error`() =
    runBlocking {
      // A request that failed at the transport layer still returns a full, successful detail
      // (valid id, headers, protocol) alongside a non-null error — it must NOT be mistaken for
      // the not-found envelope.
      val client = FakeAutoMobileClient()
      client.setResourceResponseWithText(
        "automobile:network/request/11",
        """{"id":11,"method":"GET","url":"https://x/y","host":"x","path":"/y","statusCode":0,"durationMs":0,"protocol":"h2","requestHeaders":{"accept":"*/*"},"error":"Connection reset"}""",
      )

      val result =
        RealNetworkRequestsDataSource(clientProvider = { client }, deviceId = "emulator-5554")
          .getRequestDetail(11)

      assertTrue(result is Result.Success)
      val detail = (result as Result.Success).data
      assertEquals(11L, detail.id)
      assertEquals("Connection reset", detail.error)
      assertEquals("*/*", detail.requestHeaders["accept"])
    }
}
