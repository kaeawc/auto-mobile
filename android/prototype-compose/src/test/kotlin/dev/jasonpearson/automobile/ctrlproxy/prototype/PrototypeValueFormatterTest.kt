package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDerivedEntry
import dev.jasonpearson.automobile.prototype.fixtureFile
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config

/** One actual Android ICU golden case per test, including invalid inputs and engine overrides. */
@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [35])
class PrototypeValueFormatterTest(private val name: String, private val caseJson: String) {
  companion object {
    private val fixture =
      Json.parseToJsonElement(fixtureFile("prototype-spec/derive/formatters.json").readText())
        .jsonObject
    private val environment = fixture.getValue("environment").jsonObject
    private val cases = fixture.getValue("cases").jsonArray.map { it.jsonObject }

    @JvmStatic
    @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
    fun goldenCases(): List<Array<String>> = cases.map {
      arrayOf(it.getValue("name").jsonPrimitive.content, it.toString())
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

  @Test
  fun goldenCase() {
    val case = Json.parseToJsonElement(caseJson).jsonObject
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
