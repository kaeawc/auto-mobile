package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDerivedEntry
import dev.jasonpearson.automobile.prototype.fixtureFile
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Uses actual Android ICU. Suite setup warms CLDR; calendar setup needs the test environment. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PrototypeValueFormatterTest {
  companion object {
    private val fixture =
      Json.parseToJsonElement(fixtureFile("prototype-spec/derive/formatters.json").readText())
        .jsonObject
    private val environment = fixture.getValue("environment").jsonObject
    private val cases = fixture.getValue("cases").jsonArray.map { it.jsonObject }

    @JvmStatic
    @BeforeClass
    fun warmIcu() {
      cases
        .filter { case ->
          case.getValue("format").jsonObject.keys.none {
            it == "date" || it == "time" || it == "relative"
          }
        }
        .forEach { render(it) }
    }

    private fun render(case: JsonObject): String {
      val formatter =
        AndroidPrototypeValueFormatter(
          Locale.forLanguageTag(environment.getValue("locale").jsonPrimitive.content),
          TimeZone.getTimeZone(environment.getValue("timeZone").jsonPrimitive.content),
          PrototypeClock { environment.getValue("nowMs").jsonPrimitive.long },
        )
      val entry =
        PrototypeDerivedEntry(
          JsonObject(emptyMap()),
          case.getValue("format").jsonObject,
          case["locale"]?.jsonPrimitive?.content,
          case["timeZone"]?.jsonPrimitive?.content,
        )
      return normalize(formatter.format(entry, case["of"]))
    }

    private fun normalize(text: String) = text.replace('\u202f', ' ').replace('\u00a0', ' ')
  }

  @Test fun numbers() = checkKind("number")

  @Test fun compact() = checkKind("compact")

  @Test fun currencies() = checkKind("currency")

  @Test fun percentages() = checkKind("percent")

  @Test fun dates() = checkKind("date")

  @Test fun times() = checkKind("time")

  @Test fun relative() = checkKind("relative")

  private fun checkKind(kind: String) {
    for (case in cases.filter { kind in it.getValue("format").jsonObject }) {
      val name = case.getValue("name").jsonPrimitive.content
      val output = render(case)
      val override = (case["engines"] as? JsonObject)?.get("android")
      val checks = case + ((override as? JsonObject) ?: emptyMap())
      val expected =
        (override as? JsonPrimitive)?.content ?: checks.getValue("expected").jsonPrimitive.content
      if (checks["exact"]?.jsonPrimitive?.boolean == true || override is JsonPrimitive)
        assertEquals(name, normalize(expected), output)
      if (checks["nonEmpty"]?.jsonPrimitive?.boolean == true) assertTrue(name, output.isNotEmpty())
    }
  }
}
