package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

class PrototypeRemoteImageCountsTest {
  @Test
  fun `zero counts are present even when the serializer omits other defaults`() {
    assertEquals(
      """{"loaded":0,"failed":0,"pending":0}""",
      Json.encodeToString(PrototypeRemoteImageCounts()),
    )
  }
}
