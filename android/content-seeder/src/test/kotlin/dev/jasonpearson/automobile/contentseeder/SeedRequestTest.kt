package dev.jasonpearson.automobile.contentseeder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SeedRequestTest {
  private val calendar =
    mapOf(
      "kind" to "calendar",
      "title" to "Test event",
      "startMillis" to "1000",
      "endMillis" to "2000",
    )
  private val sms =
    mapOf(
      "kind" to "sms",
      "address" to "+15555550100",
      "body" to " Test message ",
      "dateMillis" to "0",
    )

  @Test
  fun parsesCalendar() {
    assertEquals(
      SeedParseResult.Valid(SeedRequest.CalendarEvent("Test event", 1000, 2000)),
      parseSeedRequest(calendar),
    )
  }

  @Test
  fun parsesSmsAndPreservesBody() {
    assertEquals(
      SeedParseResult.Valid(SeedRequest.SmsMessage("+15555550100", " Test message ", 0)),
      parseSeedRequest(sms),
    )
  }

  @Test
  fun rejectsMissingOrUnknownKind() {
    for (kind in listOf(null, "", "contacts")) {
      assertEquals(
        SeedParseResult.Invalid("kind must be calendar or sms"),
        parseSeedRequest(mapOf("kind" to kind)),
      )
    }
  }

  @Test
  fun rejectsMissingOrBlankText() {
    for ((request, field) in listOf(calendar to "title", sms to "address", sms to "body")) {
      for (value in listOf(null, "", "  ")) {
        assertTrue(parseSeedRequest(request + (field to value)) is SeedParseResult.Invalid)
      }
    }
  }

  @Test
  fun rejectsInvalidTimestamps() {
    for ((request, field) in
      listOf(calendar to "startMillis", calendar to "endMillis", sms to "dateMillis")) {
      for (value in listOf(null, "", "abc", "1.5", "-1", "9223372036854775808")) {
        assertTrue(parseSeedRequest(request + (field to value)) is SeedParseResult.Invalid)
      }
    }
  }

  @Test
  fun rejectsNonIncreasingEventRange() {
    for (end in listOf("999", "1000")) {
      assertEquals(
        SeedParseResult.Invalid("endMillis must be after startMillis"),
        parseSeedRequest(calendar + ("endMillis" to end)),
      )
    }
  }
}
