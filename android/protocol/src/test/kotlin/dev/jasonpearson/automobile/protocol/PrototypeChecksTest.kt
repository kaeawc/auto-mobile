package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeChecksTest {
  @Test
  fun `variable quantifier budget counts optional and bounded forms`() {
    for (pattern in listOf("a?b?c?", "a{1,2}b{2,3}c{3,4}", "a{1,}b?c+")) {
      assertEquals(
        PrototypeCheckPatternResult(false, "pattern has too many variable quantifiers (max 2)"),
        PrototypeCheckPattern.parse(pattern),
      )
    }
    for (pattern in listOf("(a?){2}", "((a?))+")) assertFalse(
      PrototypeCheckPattern.parse(pattern).ok,
    )
  }

  @TestFactory
  fun authoredAnchors(): List<DynamicTest> =
    listOf("a$\\s", "a$.", "a$\\S").flatMap { pattern ->
      listOf("a\n", "a\r", "a\u0085").map { value ->
        DynamicTest.dynamicTest("absolute authored anchor $pattern with ${value.last().code}") {
          assertFalse(PrototypeCheckPattern.matches(pattern, value))
        }
      }
    }

  @TestFactory
  fun patternParity(): List<DynamicTest> = patterns.mapIndexed { index, fixture ->
    DynamicTest.dynamicTest("pattern parity $index: ${fixture["pattern"]}") {
      assertTrue(PrototypeCheckPattern.parse(fixture.text("pattern")).ok)
      assertEquals(
        fixture.getValue("matches").jsonPrimitive.boolean,
        PrototypeCheckPattern.matches(fixture.text("pattern"), fixture.text("value")),
        { fixture.toString() },
      )
    }
  }

  @TestFactory
  fun rejectedPatterns(): List<DynamicTest> = rejected.mapIndexed { index, fixture ->
    DynamicTest.dynamicTest("rejected pattern $index: ${fixture["pattern"]}") {
      val result = PrototypeCheckPattern.parse(fixture.text("pattern"))
      assertFalse(result.ok) { fixture.toString() }
      for (part in fixture.getValue("messageSubstrings").jsonArray) {
        assertTrue(result.message.orEmpty().contains(part.jsonPrimitive.content), result.toString())
      }
    }
  }

  @TestFactory
  fun formatParity(): List<DynamicTest> = formats.mapIndexed { index, fixture ->
    val format = Json.decodeFromJsonElement<PrototypeCheckFormat>(fixture.getValue("format"))
    DynamicTest.dynamicTest("format parity $index: $format") {
      assertEquals(
        fixture.getValue("matches").jsonPrimitive.boolean,
        PrototypeChecks.formatPasses(fixture.text("value"), format),
        { fixture.toString() },
      )
    }
  }

  @TestFactory
  fun evaluationParity(): List<DynamicTest> = evaluations.mapIndexed { index, fixture ->
    val checks = Json.decodeFromJsonElement<List<PrototypeCheck>>(fixture.getValue("checks"))
    val value: JsonElement? = fixture["value"]
    DynamicTest.dynamicTest("evaluation parity $index") {
      val expected = fixture.getValue("expected").jsonObject
      val result = PrototypeChecks.evaluate(value, checks, fixture.text("nodeType"))
      assertEquals(
        expected.getValue("valid").jsonPrimitive.boolean,
        result.valid,
        { fixture.toString() },
      )
      assertEquals(
        expected["firstFailingMessage"]?.jsonPrimitive?.content,
        result.firstFailingMessage,
      )
    }
  }

  @TestFactory
  fun wholeSpecFixtures(): List<DynamicTest> = specs.map { (name, fixture) ->
    val invalid = fixture["spec"] != null
    val input = if (invalid) fixture.getValue("spec").toString() else fixture.toString()
    DynamicTest.dynamicTest(name) {
      val result = PrototypeSpecValidator.validate(input)
      if (invalid) {
        assertTrue(result is PrototypeSpecValidation.Failure) { result.toString() }
        val error = (result as PrototypeSpecValidation.Failure).error
        assertEquals(fixture.text("expectedPath"), error.path)
        fixture["expectedMessage"]?.let { assertEquals(it.jsonPrimitive.content, error.message) }
      } else {
        assertTrue(result is PrototypeSpecValidation.Success) { result.toString() }
      }
    }
  }

  @Test
  fun `repeat binds validity keys and check messages`() {
    val node =
      Json.parseToJsonElement(
          """{"type":"textField","stateKey":"value_{index}","checks":[{"required":true,"message":"Enter {item.label}"}],"enabledWhen":{"all":[{"valid":["value_{index}"]},{"not":{"valid":"value_{index}"}}]},"onTap":[{"type":"emit","name":"save","requireValid":["value_{index}"]}]}""",
        )
        .jsonObject
    val seen = mutableMapOf<String, String>()
    PrototypeBindableFields.first<Boolean>(node, "root") { value, path, kind ->
      if (kind == PrototypeBindableKind.KEY || kind == PrototypeBindableKind.TEXT) {
        seen[path] =
          PrototypeRepeatTemplate.bind(
            value!!.jsonPrimitive.content,
            "item",
            Json.parseToJsonElement("""{"label":"Name"}""").jsonObject,
            2,
          )
      }
      null
    }
    assertEquals("value_2", seen["root.enabledWhen.all[0].valid[0]"])
    assertEquals("value_2", seen["root.enabledWhen.all[1].not.valid"])
    assertEquals("value_2", seen["root.onTap[0].requireValid[0]"])
    assertEquals("Enter Name", seen["root.checks[0].message"])
    val result = PrototypeSpecValidator.validate(repeatSpec)
    assertTrue(result is PrototypeSpecValidation.Success) { result.toString() }
  }

  @Test
  fun `data conditions resolve enabledWhen and preserve validity conditions`() {
    val root =
      Json.parseToJsonElement(
          """{"type":"button","label":"Save","enabledWhen":{"all":[{"data":"/allowed","equals":true},{"valid":"value"}]}}""",
        )
        .jsonObject
    val resolved =
      PrototypeDataResolver.resolveRoot(
        root,
        Json.parseToJsonElement("""{"allowed":true}""").jsonObject,
      )
    assertEquals(
      Json.parseToJsonElement("""{"all":[{"all":[]},{"valid":"value"}]}"""),
      resolved["enabledWhen"],
    )
  }

  @Test
  fun `prepared state writes retain validity guards`() {
    val spec =
      (PrototypeSpecValidator.validate(
          specs.getValue("valid/checks-enabled-button.json").toString(),
        ) as PrototypeSpecValidation.Success)
        .spec
    val prepare = PrototypeSpecValidator.prepareStateWrites(spec, Json)
    val expected =
      (PrototypeSpecValidator.validate(
          Json.encodeToString(PrototypeSpec.serializer(), spec.copy(state = emptyMap())),
        ) as PrototypeSpecValidation.Failure)
        .error
    assertEquals(expected, prepare.validate(emptyMap()))
  }

  @Test
  fun `matching cap agrees with shared contract`() {
    assertEquals(contractLimit, MAX_PROTOTYPE_CHECK_VALUE_LENGTH)
    assertTrue(
      PrototypeChecks.evaluate(
          PrototypeScalar.Text("a".repeat(4096) + "!"),
          listOf(PrototypeCheck.Pattern("a+", "invalid")),
          "textField",
        )
        .valid,
    )
    assertFalse(PrototypeCheckPattern.matches("a+", "a".repeat(4096) + "!"))
    assertFalse(
      PrototypeChecks.evaluate(
          Json.parseToJsonElement("\"${"a".repeat(4096) + "!"}\""),
          listOf(PrototypeCheck.MaxLength(4096.0, "too long")),
          "textField",
        )
        .valid,
    )
  }

  @Test
  fun `validity union and event additions round trip`() {
    for (input in listOf("\"email\"", "[\"email\",\"phone\"]")) {
      val value = Json.decodeFromString<PrototypeValidityKeys>(input)
      assertEquals(input, Json.encodeToString(PrototypeValidityKeys.serializer(), value))
    }
    for (kind in listOf(PrototypeEventKind.CHANGE, PrototypeEventKind.VALIDATION_FAILED)) {
      val event =
        PrototypeEvent(
          0,
          "checks",
          1,
          kind,
          null,
          null,
          emptyMap(),
          validity = mapOf("email" to false),
          keys = listOf("email"),
        )
      assertEquals(
        event,
        Json.decodeFromString<PrototypeEvent>(
          Json.encodeToString(PrototypeEvent.serializer(), event),
        ),
      )
    }
    val legacy = PrototypeEvent(0, "checks", 1, PrototypeEventKind.EMIT, null, null, emptyMap())
    val encoded = defaultEncoder.encodeToString(PrototypeEvent.serializer(), legacy)
    assertFalse(encoded.contains("validity"))
    assertFalse(encoded.contains("\"keys\""))
    assertEquals("prototype_checks_v1", PROTOTYPE_CHECKS_CAPABILITY)
  }

  companion object {
    private lateinit var patterns: List<JsonObject>
    private lateinit var rejected: List<JsonObject>
    private lateinit var formats: List<JsonObject>
    private lateinit var evaluations: List<JsonObject>
    private lateinit var specs: Map<String, JsonObject>
    private var contractLimit = 0
    private val defaultEncoder = Json { encodeDefaults = true }
    private const val repeatSpec =
      """{"id":"repeatChecks","window":{"placement":{"type":"fullscreen"}},"state":{"value_0":""},"root":{"type":"column","repeat":{"items":[{"label":"Name"}],"as":"item"},"children":[{"type":"textField","stateKey":"value_{index}","checks":[{"required":true,"message":"Enter {item.label}"}],"enabledWhen":{"valid":"value_{index}"}},{"type":"button","label":"Save","enabledWhen":{"valid":["value_{index}"]},"onTap":[{"type":"emit","name":"save","requireValid":["value_{index}"]}]}]}}"""

    private fun JsonObject.text(key: String): String = getValue(key).jsonPrimitive.content

    @BeforeAll
    @JvmStatic
    fun loadFixtures() {
      val directory = fixtureDirectory()
      fun cases(name: String) =
        Json.parseToJsonElement(File(directory, "checks/$name.json").readText()).jsonArray.map {
          it.jsonObject
        }
      patterns = cases("pattern-parity")
      rejected = cases("pattern-rejected")
      formats = cases("format-parity")
      evaluations = cases("evaluate")
      specs =
        listOf("valid", "invalid")
          .flatMap { folder ->
            File(directory, folder)
              .listFiles()
              .orEmpty()
              .filter { it.name.startsWith("checks-") && it.extension == "json" }
              .sortedBy { it.name }
              .map {
                "$folder/${it.name}" to Json.parseToJsonElement(it.readText()).jsonObject
              }
          }
          .toMap()
      contractLimit =
        Json.parseToJsonElement(
            checkNotNull(
                PrototypeChecksTest::class
                  .java
                  .getResourceAsStream("/prototype-spec-contract.json"),
              )
              .bufferedReader()
              .use { it.readText() },
          )
          .jsonObject
          .getValue("limits")
          .jsonObject
          .getValue("MAX_PROTOTYPE_CHECK_VALUE_LENGTH")
          .jsonPrimitive
          .int
      // Warm serializers, regex compilation and validation outside individually timed tests.
      for (fixture in patterns) PrototypeCheckPattern.matches(
        fixture.text("pattern"),
        fixture.text("value"),
      )
      for (fixture in rejected) PrototypeCheckPattern.parse(fixture.text("pattern"))
      for (fixture in formats) PrototypeChecks.formatPasses(
        fixture.text("value"),
        Json.decodeFromJsonElement(fixture.getValue("format")),
      )
      for (fixture in evaluations) PrototypeChecks.evaluate(
        fixture["value"],
        Json.decodeFromJsonElement(fixture.getValue("checks")),
        fixture.text("nodeType"),
      )
      for (fixture in specs.values) {
        val result = PrototypeSpecValidator.validate((fixture["spec"] ?: fixture).toString())
        if (result is PrototypeSpecValidation.Success)
          Json.encodeToString(PrototypeSpec.serializer(), result.spec)
      }
      Json.encodeToString(
        PrototypeEvent.serializer(),
        PrototypeEvent(0, "warm", 1, PrototypeEventKind.CHANGE, null, null, emptyMap()),
      )
      Json.decodeFromString<PrototypeValidityKeys>("\"warm\"")
      PrototypeSpecValidator.validate(repeatSpec)
      val suite = PrototypeChecksTest()
      suite.`repeat binds validity keys and check messages`()
      suite.`data conditions resolve enabledWhen and preserve validity conditions`()
      suite.`prepared state writes retain validity guards`()
    }
  }
}
