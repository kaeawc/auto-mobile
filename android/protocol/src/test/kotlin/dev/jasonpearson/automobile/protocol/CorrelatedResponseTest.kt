package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Test

/**
 * The server routes a reply to its awaiter by reading [CorrelatedResponse.requestId], so a response
 * type that declares `requestId` without implementing [CorrelatedResponse] would never be routed
 * and its awaiter would time out. This replaces the exhaustive per-type `when` the server used to
 * carry for the same purpose (#11877).
 */
class CorrelatedResponseTest {
  /** Every concrete response type, walking through any sealed intermediate subclasses. */
  private val responseTypes: List<Class<*>> = concreteSubclasses(WebSocketResponse::class.java)

  private fun concreteSubclasses(type: Class<*>): List<Class<*>> =
    type.permittedSubclasses?.flatMap(::concreteSubclasses) ?: listOf(type)

  private fun declaresRequestId(type: Class<*>): Boolean {
    val descriptor = serializer(type).descriptor
    return (0 until descriptor.elementsCount).any { descriptor.getElementName(it) == "requestId" }
  }

  @Test
  fun `the response hierarchy is enumerable`() {
    // Guards against an empty list making the parity check below vacuous.
    assertTrue(responseTypes.size > 40, "found ${responseTypes.size} response types")
  }

  @Test
  fun `a response type implements CorrelatedResponse exactly when it declares requestId`() {
    val mismatched =
      responseTypes
        .filter { declaresRequestId(it) != CorrelatedResponse::class.java.isAssignableFrom(it) }
        .map { it.simpleName }
    assertEquals(emptyList(), mismatched)
  }

  @Test
  fun `a correlated response exposes the id it was built with`() {
    val response: WebSocketResponse =
      SwipeResult(timestamp = 1L, requestId = "req-1", success = true, totalTimeMs = 5L)
    assertEquals("req-1", (response as CorrelatedResponse).requestId)
  }
}
