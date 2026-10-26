package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeDerivedTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warmCodec() {
      PrototypeDerivedTest().`derive round trips with repeat`()
    }
  }

  @Test
  fun `derived span grammar preserves malformed names`() {
    assertEquals(
      listOf("valid", "next"),
      PrototypeDerivedText.names("{derived:valid} {derived:bad-name} {derived:} {derived:next}"),
    )
    assertEquals(-1, PrototypeDerivedText.tokenEnd("{derived:unclosed", 0))
  }

  @Test
  fun `derive round trips with repeat`() {
    val entry =
      PrototypeDerivedEntry(
        buildJsonObject { put("value", 12) },
        buildJsonObject { put("number", JsonObject(emptyMap())) },
      )
    val repeat = PrototypeRepeat(listOf(emptyMap()), "item", derive = mapOf("price" to entry))
    val json = PrototypeSpecValidator.json
    assertEquals(
      repeat,
      json.decodeFromString(
        PrototypeRepeat.serializer(),
        json.encodeToString(PrototypeRepeat.serializer(), repeat),
      ),
    )
  }
}
