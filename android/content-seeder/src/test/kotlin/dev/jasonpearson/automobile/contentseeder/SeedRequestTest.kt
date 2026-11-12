package dev.jasonpearson.automobile.contentseeder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** JSON decoding belongs to Android's org.json; this fake keeps protocol validation JVM-only. */
private class FakeSeedItemsReader(val items: List<Map<String, Any?>>) : SeedItemsReader {
  var json: String? = null

  override fun read(json: String): List<Map<String, Any?>> {
    this.json = json
    require(json == "[]" || json.startsWith("[{")) { "Invalid JSON array" }
    return items
  }
}

class SeedRequestTest {
  @Test
  fun parsesPhotoWithoutJsonAndRejectsInvalidIdsOrUnscopedFiles() {
    val parameters =
      mapOf(
        "kind" to "photo",
        "namespace" to "ns1",
        "rawContactId" to "3",
        "photoFile" to "automobile.ns1.3.photo",
      )
    val reader = FakeSeedItemsReader(emptyList())
    assertEquals(
      SeedParseResult.Valid(SeedRequest.Photo("ns1", 3, "automobile.ns1.3.photo")),
      parseSeedRequest(parameters, reader),
    )
    assertEquals(null, reader.json)
    for (id in listOf(null, "", "0", "-1", "1.5", "9223372036854775808")) {
      assertTrue(
        parseSeedRequest(parameters + ("rawContactId" to id), reader) is SeedParseResult.Invalid,
      )
    }
    for (file in
      listOf(
        null,
        "",
        "../automobile.ns1.3.photo",
        "/data/local/tmp/a.png",
        "automobile.other.3.photo",
        "automobile.ns1.4.photo",
      )) {
      assertTrue(
        parseSeedRequest(parameters + ("photoFile" to file), reader) is SeedParseResult.Invalid,
      )
    }
  }

  private val calendar =
    mapOf("title" to "Test event", "startMillis" to 1000L, "endMillis" to 2000L)
  private val sms =
    mapOf("address" to "+15555550100", "body" to " Test message ", "dateMillis" to 0L)
  private val parameters = mapOf("namespace" to "ns1", "items" to "[{\"title\":\"Test event\"}]")

  @Test
  fun parsesCalendarJsonBatchAndNamespace() {
    val reader = FakeSeedItemsReader(listOf(calendar, calendar + ("calendar" to "Work")))
    assertEquals(
      SeedParseResult.Valid(
        SeedRequest.CalendarBatch(
          "ns1",
          listOf(
            SeedRequest.CalendarEvent("Test event", 1000, 2000, false, null, "automobile-ns1"),
            SeedRequest.CalendarEvent("Test event", 1000, 2000, false, null, "Work"),
          ),
        ),
      ),
      parseSeedRequest(parameters + ("kind" to "calendar"), reader),
    )
    assertEquals(parameters["items"], reader.json)
  }

  @Test
  fun parsesSmsJsonBatchReadFlagAndPreservesBody() {
    assertEquals(
      SeedParseResult.Valid(
        SeedRequest.SmsBatch(
          "ns1",
          listOf(SeedRequest.SmsMessage("+15555550100", " Test message ", 0, true)),
        ),
      ),
      parseSeedRequest(
        parameters + ("kind" to "sms"),
        FakeSeedItemsReader(listOf(sms + ("read" to true))),
      ),
    )
    assertEquals(
      SeedParseResult.Valid(
        SeedRequest.SmsBatch(
          "ns1",
          listOf(SeedRequest.SmsMessage("+15555550100", " Test message ", 0, false)),
        ),
      ),
      parseSeedRequest(parameters + ("kind" to "sms"), FakeSeedItemsReader(listOf(sms))),
    )
  }

  @Test
  fun parsesResetWithoutItemsAndRejectsUnscopedKinds() {
    assertEquals(
      SeedParseResult.Valid(SeedRequest.Reset("ns1", setOf("calendar", "sms"))),
      parseSeedRequest(mapOf("kind" to "reset", "namespace" to "ns1", "kinds" to "calendar,sms")),
    )
    assertTrue(
      parseSeedRequest(mapOf("kind" to "reset", "namespace" to "ns1", "kinds" to "all"))
        is SeedParseResult.Invalid,
    )
  }

  @Test
  fun parsesAccountWithoutReadingItems() {
    val reader = FakeSeedItemsReader(emptyList())
    assertEquals(
      SeedParseResult.Valid(SeedRequest.Account("ns1")),
      parseSeedRequest(mapOf("kind" to "account", "namespace" to "ns1"), reader),
    )
    assertEquals(null, reader.json)
    assertTrue(
      parseSeedRequest(mapOf("kind" to "account", "namespace" to "bad namespace"), reader)
        is SeedParseResult.Invalid,
    )
  }

  @Test
  fun resetPreservesAccountUnlessExplicitlyDroppedAfterDataDeletes() {
    for (kind in listOf("calendar", "sms", "calendar,sms")) {
      val parameters = mapOf("kind" to "reset", "namespace" to "ns1", "kinds" to kind)
      assertEquals(
        SeedParseResult.Valid(SeedRequest.Reset("ns1", kind.split(",").toSet(), false)),
        parseSeedRequest(parameters),
      )
      assertEquals(
        SeedParseResult.Valid(SeedRequest.Reset("ns1", kind.split(",").toSet(), true)),
        parseSeedRequest(parameters + ("dropAccount" to "true")),
      )
    }
    assertEquals(
      SeedParseResult.Valid(SeedRequest.Reset("ns1", emptySet(), true)),
      parseSeedRequest(mapOf("kind" to "reset", "namespace" to "ns1", "dropAccount" to "true")),
    )
    for (flag in listOf(null, "false", "TRUE", "yes", "")) {
      assertTrue(
        parseSeedRequest(mapOf("kind" to "reset", "namespace" to "ns1", "dropAccount" to flag))
          is SeedParseResult.Invalid,
      )
    }
  }

  @Test
  fun rejectsInvalidNamespaceBeforeJsonReading() {
    for (namespace in listOf(null, "", "a:b", "a b", "x".repeat(33))) {
      val reader = FakeSeedItemsReader(listOf(calendar))
      assertTrue(
        parseSeedRequest(
          parameters + ("namespace" to namespace) + ("kind" to "calendar"),
          reader,
        )
          is SeedParseResult.Invalid,
      )
      assertEquals(null, reader.json)
    }
  }

  @Test
  fun rejectsMissingOrMalformedJsonAndUnknownKind() {
    val reader = FakeSeedItemsReader(emptyList())
    for (items in listOf(null, "not-json", "{}")) {
      assertTrue(
        parseSeedRequest(parameters + ("items" to items) + ("kind" to "sms"), reader)
          is SeedParseResult.Invalid,
      )
    }
    assertTrue(
      parseSeedRequest(parameters + ("kind" to "contacts"), reader) is SeedParseResult.Invalid,
    )
    assertEquals(
      SeedParseResult.Valid(SeedRequest.SmsBatch("ns1", emptyList())),
      parseSeedRequest(parameters + ("kind" to "sms") + ("items" to "[]"), reader),
    )
  }

  @Test
  fun rejectsBlankTextsInvalidTimestampTypesAndNonIncreasingRange() {
    val invalid =
      listOf(
        calendar + ("title" to " "),
        calendar + ("startMillis" to "1000"),
        calendar + ("startMillis" to 1.5),
        calendar + ("endMillis" to 1000),
        calendar + ("allDay" to "true"),
        calendar + ("allDay" to true),
      )
    invalid.forEach { item ->
      assertTrue(
        parseSeedRequest(parameters + ("kind" to "calendar"), FakeSeedItemsReader(listOf(item)))
          is SeedParseResult.Invalid,
      )
    }
  }

  @Test
  fun parsesAllDayExclusiveUtcRangeAndLocation() {
    val item =
      calendar +
        mapOf(
          "startMillis" to 0L,
          "endMillis" to 86_400_000L,
          "allDay" to true,
          "location" to "Room A",
        )
    assertEquals(
      SeedParseResult.Valid(
        SeedRequest.CalendarBatch(
          "ns1",
          listOf(
            SeedRequest.CalendarEvent(
              "Test event",
              0,
              86_400_000,
              true,
              "Room A",
              "automobile-ns1",
            ),
          ),
        ),
      ),
      parseSeedRequest(parameters + ("kind" to "calendar"), FakeSeedItemsReader(listOf(item))),
    )
  }
}
