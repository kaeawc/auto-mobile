package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

class NavigationEventWireTest {

  @Test
  fun `navigation response retains the SDK event timestamp`() {
    val event =
      TimestampedNavigationEvent(
        destination = "profile",
        source = "COMPOSE_NAVIGATION",
        arguments = mapOf("userId" to "42"),
        metadata = mapOf("origin" to "deep-link"),
        timestamp = 1234L,
        sequenceNumber = 5L,
        applicationId = "com.example.app",
      )

    val response = navigationEventResponse(event)

    assertEquals(1234L, response.timestamp)
    assertEquals("profile", response.event.destination)
    assertEquals("COMPOSE_NAVIGATION", response.event.source)
    assertEquals(mapOf("userId" to "42"), response.event.arguments)
    assertEquals(mapOf("origin" to "deep-link"), response.event.metadata)
    assertEquals(5L, response.event.sequenceNumber)
    assertEquals("com.example.app", response.event.applicationId)
  }
}
