package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkGraphFlattenTest {

  private val json = Json { ignoreUnknownKeys = true }

  private fun parse(text: String): List<NetworkGraphHost> =
    json.decodeFromString(NetworkGraphResponse.serializer(), text).graph

  @Test
  fun `flattens a host tree into one row per leaf`() {
    val hosts =
      parse(
        """
        {
          "graph": [
            {
              "scheme": "https",
              "host": "api.example.com",
              "paths": {
                "users[GET]": {"method":"GET","type":"application/json","success":3,"errors":1,"p50":10,"p95":20},
                "users": {
                  "paths": {
                    "{id}[GET]": {"method":"GET","success":5,"errors":0,"p50":8,"p95":15,"parameterized":true}
                  }
                },
                "[GET]": {"method":"GET","success":2,"errors":0,"p50":1,"p95":2}
              }
            }
          ]
        }
        """
          .trimIndent()
      )

    val rows = flattenNetworkGraph(hosts)

    assertEquals(3, rows.size)

    val users = rows.first { it.path == "/users" }
    assertEquals("api.example.com", users.host)
    assertEquals("GET", users.method)
    assertEquals("application/json", users.type)
    assertEquals(3, users.success)
    assertEquals(1, users.errors)
    assertEquals(10, users.p50)
    assertEquals(20, users.p95)
  }

  @Test
  fun `joins nested segments and preserves the parameterized marker`() {
    val hosts =
      parse(
        """
        {"graph":[{"scheme":"https","host":"api.example.com","paths":{
          "users":{"paths":{"{id}[GET]":{"method":"GET","success":5,"errors":0,"p50":8,"p95":15}}}
        }}]}
        """
          .trimIndent()
      )

    val rows = flattenNetworkGraph(hosts)

    val nested = rows.firstOrNull { it.path == "/users/{id}" }
    assertNotNull("expected a flattened row for the parameterized path", nested)
    assertEquals(5, nested!!.success)
  }

  @Test
  fun `preserves a bracketed intermediate segment and strips only the leaf method suffix`() {
    val hosts =
      parse(
        """
        {"graph":[{"scheme":"https","host":"api.example.com","paths":{
          "items[archived]":{"paths":{"detail[GET]":{"method":"GET","success":4,"errors":0,"p50":5,"p95":9}}}
        }}]}
        """
          .trimIndent()
      )

    val rows = flattenNetworkGraph(hosts)

    assertEquals(1, rows.size)
    // The `[archived]` branch segment must survive; only the leaf's `[GET]` is stripped.
    assertEquals("/items[archived]/detail", rows.first().path)
    assertEquals("GET", rows.first().method)
  }

  @Test
  fun `renders the root path as slash`() {
    val hosts =
      parse(
        """
        {"graph":[{"scheme":"https","host":"api.example.com","paths":{
          "[GET]":{"method":"GET","success":2,"errors":0,"p50":1,"p95":2}
        }}]}
        """
          .trimIndent()
      )

    val rows = flattenNetworkGraph(hosts)

    assertEquals(1, rows.size)
    assertEquals("/", rows.first().path)
  }

  @Test
  fun `an empty graph flattens to no rows`() {
    assertTrue(flattenNetworkGraph(parse("""{"graph":[]}""")).isEmpty())
  }
}
