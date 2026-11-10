package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Plain JVM coverage: one case per contract name and style keeps each test small. */
@RunWith(Parameterized::class)
class PrototypeIconContractTest(private val name: String, private val variant: String) {
  @Test
  fun contractIconResolves() {
    assertNotNull("Contract icon '$name' must resolve in '$variant'", prototypeIcon(name, variant))
  }

  companion object {
    @JvmStatic
    @Parameterized.Parameters(name = "{0} / {1}")
    fun icons(): List<Array<String>> {
      val contract =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "schemas/prototype-spec-contract.json") }
          .firstOrNull { it.isFile }
      checkNotNull(contract) {
        "Cannot find schemas/prototype-spec-contract.json walking up from ${System.getProperty("user.dir")}"
      }
      // kotlinx.serialization is already an API dependency of the renderer.
      val definition =
        Json.parseToJsonElement(contract.readText())
          .jsonObject
          .getValue("definitions")
          .jsonObject
          .getValue("iconName")
          .jsonObject
      check(definition.getValue("kind").jsonPrimitive.content == "enum")
      val names = definition.getValue("values").jsonArray.map { it.jsonPrimitive.content }
      check(names.isNotEmpty()) { "Contract iconName enum is empty" }
      return names.flatMap { name ->
        listOf("filled", "outlined", "rounded", "sharp", "twoTone").map { arrayOf(name, it) }
      }
    }
  }
}
