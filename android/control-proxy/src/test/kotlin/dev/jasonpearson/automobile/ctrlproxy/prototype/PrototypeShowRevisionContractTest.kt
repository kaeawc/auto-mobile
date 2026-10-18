package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.File
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The revision a show reports (#13040): replays `test/fixtures/prototype-spec/revision/
 * show-revisions.json`, which the iOS prototype agent's session tests replay too, so both platforms
 * answer the same numbers (the first show of an id is revision 1, a re-show moves it on).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeShowRevisionContractTest {
  private val sink =
    object : PrototypeResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) = Unit
    }
  private val controller =
    PrototypeController(
      FakePrototypeHost(),
      sink,
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
    )

  private fun fixture(): JsonObject {
    val file =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec/revision/show-revisions.json") }
        .first { it.isFile }
    return Json.parseToJsonElement(file.readText()).jsonObject
  }

  private fun spec(json: String): PrototypeSpec {
    val validation = PrototypeSpecValidator.validate(json)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  @Test
  fun `each show reports the revision the shared fixture pins`() = runTest {
    val fixture = fixture()
    val specs = fixture.getValue("specs").jsonObject
    for (show in fixture.getValue("shows").jsonArray) {
      val entry = show.jsonObject
      val name = entry.getValue("spec").jsonPrimitive.content
      controller.show("req", spec(specs.getValue(name).toString()))
      assertEquals(
        "show of $name",
        entry.getValue("revision").jsonPrimitive.int.toLong(),
        checkNotNull(controller.activeRuntime).current.revision,
      )
    }
  }
}
