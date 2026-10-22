package dev.jasonpearson.automobile.protocol

import kotlin.test.*
import kotlinx.serialization.json.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeBundleCorpusTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun prepare() {
      // Decode once outside individual test timing; also warm the existing contract/validator.
      PrototypeBundleReader.read(PrototypeBundleCorpus.cases.first().bytes)
    }
  }

  @TestFactory
  fun `reader matches every shared corpus verdict code and path`(): List<DynamicTest> =
    PrototypeBundleCorpus.cases.map { case ->
      DynamicTest.dynamicTest(case.name) {
        val result = PrototypeBundleReader.read(case.bytes)
        if (case.accepted) assertIs<PrototypeBundleReadResult.Success>(result, case.name)
        else {
          val failure = assertIs<PrototypeBundleReadResult.Rejected>(result, case.name)
          assertEquals(
            case.value.getValue("code").jsonPrimitive.content,
            failure.code.name,
            case.name,
          )
          assertEquals(case.value["path"]?.jsonPrimitive?.content, failure.path, case.name)
        }
      }
    }

  @TestFactory
  fun `export is byte identical to canonical goldens`(): List<DynamicTest> =
    PrototypeBundleCorpus.cases
      .filter { "exportInputs" in it.value }
      .map { case ->
        DynamicTest.dynamicTest(case.name) {
          val result =
            assertIs<PrototypeBundleExportResult.Success>(
              PrototypeBundleExport.export(
                PrototypeBundleCorpus.input(case.value.getValue("exportInputs").jsonObject),
              ),
            )
          assertContentEquals(case.bytes, result.bytes)
        }
      }

  @TestFactory
  fun `every truncation rejects without crashing`(): List<DynamicTest> {
    val bytes = PrototypeBundleCorpus.cases.first().bytes
    return bytes.indices.chunked(32).map { offsets ->
      DynamicTest.dynamicTest("truncate ${offsets.first()} through ${offsets.last()}") {
        for (offset in offsets) assertIs<PrototypeBundleReadResult.Rejected>(
          PrototypeBundleReader.read(bytes.copyOf(offset)),
          "offset $offset",
        )
      }
    }
  }

  @Test
  fun `error vocabulary and limits match transport contract`() {
    val root = PrototypeBundleCorpus.root
    assertEquals(
      root.getValue("errorCodes").jsonArray.map { it.jsonPrimitive.content },
      PrototypeBundleErrorCode.entries.map { it.name },
    )
    val caps = root.getValue("caps").jsonObject.mapValues { it.value.jsonPrimitive.int }
    assertEquals(
      mapOf(
        "entries" to PrototypeBundleLimits.MAX_ENTRIES,
        "spec" to PrototypeBundleLimits.MAX_SPEC_BYTES,
        "manifest" to PrototypeBundleLimits.MAX_MANIFEST_BYTES,
        "expanded" to PrototypeBundleLimits.MAX_EXPANDED_BYTES,
        "compressed" to PrototypeBundleLimits.MAX_COMPRESSED_BYTES,
        "ratio" to PrototypeBundleLimits.MAX_RATIO,
      ),
      caps,
    )
  }
}
