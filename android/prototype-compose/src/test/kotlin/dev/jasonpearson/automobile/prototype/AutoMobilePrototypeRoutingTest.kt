package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeRequests
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

@RunWith(ParameterizedRobolectricTestRunner::class)
class AutoMobilePrototypeRoutingTest(private val name: String, caseInput: String) {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()
  private val case = Json.parseToJsonElement(caseInput).jsonObject

  companion object {
    @JvmStatic
    @Parameters(name = "{0}")
    fun routes(): List<Array<Any>> =
      Json.parseToJsonElement(fixtureFile("prototype-embedded-routing/routing.json").readText())
        .jsonArray
        .map { arrayOf<Any>(it.jsonObject.getValue("name").jsonPrimitive.content, it.toString()) }

    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `request reaches expected client and emits shared outcome`() {
    val device = FakePrototypeHttp()
    val handler = FakePrototypeHttp()
    val events = mutableListOf<PrototypeEvent>()
    val via = case.getValue("via").jsonPrimitive.contentOrNull
    val network =
      PrototypeNetwork(
        device,
        if (case.getValue("hostHandler").jsonPrimitive.boolean) handler else null,
      )
    val input = requestSpec(via)
    compose.setContent {
      host.Content { AutoMobilePrototype(input, network = network, onEvent = { events += it }) }
    }
    compose.onNodeWithTag("go").performClick()
    compose.runOnIdle {
      val useHandler = case.getValue("expectedRoute").jsonPrimitive.content == "handler"
      assertEquals(name, if (useHandler) 0 else 1, device.requests.size)
      assertEquals(name, if (useHandler) 1 else 0, handler.requests.size)
      val request = (if (useHandler) handler else device).requests.single()
      assertEquals("https://example.test/feed", request.url)
      assertEquals("embedded", request.prototypeId)
      assertEquals("request-1", request.requestId)
      assertEquals("GET", request.method)
      val event = events.single { it.name == PrototypeRequests.EVENT_NAME }
      val outcome = event.payload!!.jsonObject
      assertEquals(JsonPrimitive(via ?: "host"), outcome["via"])
      assertEquals(JsonPrimitive("success"), outcome["outcome"])
      assertEquals(JsonPrimitive(200), outcome["status"])
      assertEquals(JsonPrimitive(9), outcome["durationMs"])
    }
  }
}
