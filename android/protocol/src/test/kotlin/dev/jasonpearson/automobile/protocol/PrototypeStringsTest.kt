package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeStringsTest {
  @TestFactory
  fun resolveFixtures(): List<DynamicTest> = resolve.map { case ->
    DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
      assertEquals(
        case.getValue("expected").jsonPrimitive.content,
        PrototypeStrings.resolveText(
          case.getValue("strings").jsonObject,
          case.getValue("locales").jsonArray.map { it.jsonPrimitive.content },
          case.getValue("text").jsonPrimitive.content,
          case["data"] as? JsonObject,
        ),
      )
    }
  }

  @TestFactory
  fun pluralFixtures(): List<DynamicTest> = plurals.flatMap { (language, cases) ->
    cases.jsonArray.map { raw ->
      val case = raw.jsonObject
      val n = case.getValue("n").jsonPrimitive.double
      DynamicTest.dynamicTest("$language $n") {
        assertEquals(
          case.getValue("category").jsonPrimitive.content,
          PrototypeStrings.pluralCategory(language, n),
        )
      }
    }
  }

  @Test
  fun `substituted counts accept only one to nine digits`() {
    val tables =
      Json.parseToJsonElement("""{"default":{"n":{"one":"{#} one","other":"{#} other"}}}""")
        .jsonObject
    for (count in listOf("1", "01", "000000001")) {
      assertEquals("1 one", PrototypeStrings.resolveText(tables, listOf("en"), "{t:n|$count}"))
    }
    for (count in
      listOf("+1", "1e0", "0x1", "0b1", "0o1", " 1", "1000000000", "1f", "-1", "1.5", "NaN")) {
      assertEquals("{#} other", PrototypeStrings.resolveText(tables, listOf("en"), "{t:n|$count}"))
    }
  }

  @Test
  fun `bundle requirements include strings and semantics without scanning table keys as fields`() {
    assertEquals(
      listOf("prototype_data_model_v1", "prototype_semantics_v1", "prototype_strings_v1"),
      PrototypeBundleCapabilities.required(localizedReferences),
    )
  }

  @Test
  fun `locale chain deduplicates prefixes and keeps device preference order`() {
    assertEquals(
      listOf("zh-hant-tw", "zh-hant", "zh", "fr-ca", "fr", "default"),
      PrototypeStrings.localeChain(listOf("zh-Hant-TW", "ZH", "fr_CA")),
    )
  }

  @Test
  fun `whole spec transform respects opaque fields and translation state tokens`() {
    val spec =
      Json.parseToJsonElement(
          """{"strings":{"default":{"label":"Hi {name}"}},"data":{"label":"{t:label}"},
        "root":{"type":"text","text":"{t:label}","semantics":{"label":"{t:label}"}}}""",
        )
        .jsonObject
    val result = PrototypeStrings.resolve(spec, listOf("en"))
    assertEquals(spec["strings"], result["strings"])
    assertEquals(spec["data"], result["data"])
    assertEquals(
      "Hi {name}",
      result.getValue("root").jsonObject.getValue("text").jsonPrimitive.content,
    )
    assertEquals(
      "Hi {name}",
      result
        .getValue("root")
        .jsonObject
        .getValue("semantics")
        .jsonObject
        .getValue("label")
        .jsonPrimitive
        .content,
    )
  }

  companion object {
    private lateinit var resolve: List<JsonObject>
    private lateinit var plurals: JsonObject
    private lateinit var localizedReferences: PrototypeBundleReferences

    @JvmStatic
    @BeforeAll
    fun loadFixtures() {
      localizedReferences =
        PrototypeBundleSpec.references(
          File(fixtureDirectory(), "valid/strings-and-semantics.json").readBytes(),
        )
      resolve =
        Json.parseToJsonElement(File(fixtureDirectory(), "strings/resolve.json").readText())
          .jsonArray
          .map { it.jsonObject }
      plurals =
        Json.parseToJsonElement(
            File(fixtureDirectory(), "strings/plural-categories.json").readText(),
          )
          .jsonObject
      // Initialize the contract and regexes outside the timed tests.
      PrototypeStrings.resolveText(resolve.first().getValue("strings").jsonObject, emptyList(), "")
    }
  }
}
