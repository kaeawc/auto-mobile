package dev.jasonpearson.automobile.prototype

import androidx.compose.material3.Text
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AutoMobilePrototypeTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `invalid spec draws only error content with canonical validator path`() {
    val input =
      embeddedSpec("""{"type":"column","testTag":"partial","children":[{"type":"futureNode"}]}""")
    val expected = (PrototypeSpecValidator.validate(input) as PrototypeSpecValidation.Failure).error
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          input,
          onError = {
            val error = it as PrototypeLoadError.Invalid
            Text("${error.path}: ${error.message}")
          },
        )
      }
    }
    compose.onNodeWithText("${expected.path}: ${expected.message}").assertExists()
    compose.onNodeWithTag("partial").assertDoesNotExist()
  }

  @Test
  fun `default error content is visible`() {
    compose.setContent { host.Content { AutoMobilePrototype("{}") } }
    compose.onNodeWithText("Cannot load prototype at", substring = true).assertIsDisplayed()
  }

  @Test
  fun `tap delivers typed event with fake timestamp`() {
    val events = mutableListOf<PrototypeEvent>()
    val input =
      embeddedSpec(
        """{"type":"button","testTag":"go","label":"Go","onTap":[{"type":"emit","name":"tapped"}]}""",
      )
    compose.setContent { host.Content { AutoMobilePrototype(input, onEvent = { events += it }) } }
    compose.onNodeWithTag("go").performClick()
    compose.runOnIdle {
      val event = events.single()
      assertEquals(PrototypeEventKind.EMIT, event.kind)
      assertEquals("tapped", event.name)
      assertEquals("embedded", event.id)
      assertEquals(1L, event.sequence)
      assertEquals(0L, event.timestamp)
    }
  }

  @Test
  fun `stored interaction flushes on stop and restores before drawing again`() {
    val storage = FakePrototypeStorage()
    val shown = mutableStateOf(true)
    val input = storedSwitchSpec()
    compose.setContent {
      host.Content { if (shown.value) AutoMobilePrototype(input, storage = storage) }
    }
    compose.onNodeWithTag("dark").assertIsOff().performClick()
    compose.onNodeWithTag("dark").assertIsOn()
    compose.runOnIdle {
      assertEquals(0, storage.saves)
      (host.owner.lifecycle as LifecycleRegistry).handleLifecycleEvent(Lifecycle.Event.ON_STOP)
      assertEquals(1, storage.saves)
      assertEquals(JsonPrimitive(true), storage.load("embedded")?.values?.get("state:dark"))
      shown.value = false
    }
    compose.onNodeWithTag("dark").assertDoesNotExist()
    compose.runOnIdle { shown.value = true }
    compose.onNodeWithTag("dark").assertIsOn()
  }

  @Test
  fun `dispose flushes before the virtual debounce expires`() {
    val storage = FakePrototypeStorage()
    val shown = mutableStateOf(true)
    val input = storedSwitchSpec()
    compose.setContent {
      host.Content { if (shown.value) AutoMobilePrototype(input, storage = storage) }
    }
    compose.onNodeWithTag("dark").performClick()
    compose.runOnIdle { shown.value = false }
    compose.onNodeWithTag("dark").assertDoesNotExist()
    compose.runOnIdle {
      assertEquals(1, storage.saves)
      assertEquals(0L, host.scope.testScheduler.currentTime)
      assertEquals(JsonPrimitive(true), storage.load("embedded")?.values?.get("state:dark"))
    }
  }

  @Test
  fun `dispose cancels an in flight HTTP call without dismissal`() {
    var started = false
    var cancelled = false
    val dismissed = mutableListOf<PrototypeDismissReason>()
    val client = PrototypeHttpClient {
      started = true
      try {
        awaitCancellation()
      } finally {
        cancelled = true
      }
    }
    val shown = mutableStateOf(true)
    val input = requestSpec()
    val network = PrototypeNetwork(client)
    compose.setContent {
      host.Content {
        if (shown.value)
          AutoMobilePrototype(input, network = network, onDismiss = { dismissed += it })
      }
    }
    compose.onNodeWithTag("go").performClick()
    compose.runOnIdle {
      assertTrue(started)
      assertFalse(cancelled)
      shown.value = false
    }
    compose.onNodeWithTag("go").assertDoesNotExist()
    compose.runOnIdle {
      assertTrue(cancelled)
      assertTrue(dismissed.isEmpty())
    }
  }

  @Test
  fun `authored dismiss reports its reason once and removes content`() {
    val dismissed = mutableListOf<PrototypeDismissReason>()
    val events = mutableListOf<PrototypeEvent>()
    val input =
      mutableStateOf(
        embeddedSpec(
          """{"type":"button","testTag":"go","label":"Close","onTap":[{"type":"dismiss"}]}""",
        ),
      )
    val identity = mutableStateOf(0)
    val handleBack = mutableStateOf(false)
    compose.setContent {
      host.Content {
        key(identity.value) {
          AutoMobilePrototype(
            input.value,
            onEvent = { events += it },
            onDismiss = { dismissed += it },
            handleBack = handleBack.value,
          )
        }
      }
    }
    compose.onNodeWithTag("go").performClick()
    compose.onNodeWithTag("go").assertDoesNotExist()
    compose.runOnIdle {
      assertEquals(listOf(PrototypeDismissReason.USER), dismissed)
      assertEquals(listOf(PrototypeEventKind.DISMISSED), events.map { it.kind })
      handleBack.value = true
    }
    compose.onNodeWithTag("go").assertDoesNotExist()
    compose.runOnIdle { input.value += " " }
    compose.onNodeWithTag("go").assertExists().performClick()
    compose.onNodeWithTag("go").assertDoesNotExist()
    compose.runOnIdle {
      assertEquals(listOf(PrototypeDismissReason.USER, PrototypeDismissReason.USER), dismissed)
      identity.value++
    }
    compose.onNodeWithTag("go").assertExists()
  }

  @Test
  fun `back handling is opt in and stops after dismissal`() {
    val handleBack = mutableStateOf(false)
    val dismissed = mutableListOf<PrototypeDismissReason>()
    val input = storedSwitchSpec()
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          input,
          onDismiss = { dismissed += it },
          handleBack = handleBack.value,
        )
      }
    }
    compose.onNodeWithTag("dark").performClick()
    compose.runOnIdle {
      host.backInput.backCompleted()
      assertEquals(1, host.unhandledBacks)
      assertTrue(dismissed.isEmpty())
      handleBack.value = true
    }
    compose.onNodeWithTag("dark").assertIsOn()
    compose.runOnIdle { host.backInput.backCompleted() }
    compose.onNodeWithTag("dark").assertDoesNotExist()
    compose.runOnIdle {
      assertEquals(listOf(PrototypeDismissReason.USER), dismissed)
      assertEquals(1, host.unhandledBacks)
      host.backInput.backCompleted()
      assertEquals(2, host.unhandledBacks)
      assertEquals(1, dismissed.size)
    }
  }

  @Test
  fun `replacing network with the same clients reloads runtime`() {
    val client = FakePrototypeHttp()
    val network = mutableStateOf(PrototypeNetwork(client))
    val input = storedSwitchSpec()
    compose.setContent {
      host.Content { AutoMobilePrototype(input, network = network.value) }
    }
    compose.onNodeWithTag("dark").performClick()
    compose.onNodeWithTag("dark").assertIsOn()
    compose.runOnIdle { network.value = PrototypeNetwork(client) }
    compose.onNodeWithTag("dark").assertIsOff()
  }

  @Test
  fun `storage cancellation propagates without load error content`() {
    val storage = FakePrototypeStorage(CancellationException("Cancelled"))
    val errors = mutableListOf<PrototypeLoadError>()
    val input = storedSwitchSpec()
    compose.setContent {
      host.Content {
        AutoMobilePrototype(input, storage = storage, onError = { errors += it })
      }
    }
    compose.onNodeWithTag("dark").assertDoesNotExist()
    compose.runOnIdle { assertTrue(errors.isEmpty()) }
  }

  @Test
  fun `without device client even a host handler fails as typed network error`() {
    val handler = FakePrototypeHttp()
    val events = mutableListOf<PrototypeEvent>()
    val network = PrototypeNetwork(hostHandler = handler)
    val input = requestSpec()
    compose.setContent {
      host.Content { AutoMobilePrototype(input, network = network, onEvent = { events += it }) }
    }
    compose.onNodeWithTag("go").performClick()
    compose.runOnIdle {
      assertTrue(handler.requests.isEmpty())
      val payload = events.single { it.name == PrototypeRequests.EVENT_NAME }.payload!!.jsonObject
      assertEquals(JsonPrimitive("error"), payload["outcome"])
      assertEquals(JsonPrimitive("network"), payload.getValue("error").jsonObject["code"])
    }
  }

  @Test
  fun `callback updates keep runtime state and use latest callback`() {
    val first = mutableListOf<PrototypeEvent>()
    val second = mutableListOf<PrototypeEvent>()
    val callback = mutableStateOf<(PrototypeEvent) -> Unit>({ first += it })
    val input = storedSwitchSpec()
    compose.setContent {
      host.Content { AutoMobilePrototype(input, onEvent = callback.value) }
    }
    compose.onNodeWithTag("dark").performClick()
    compose.runOnIdle { callback.value = { second += it } }
    compose.onNodeWithTag("dark").assertIsOn().performClick()
    compose.runOnIdle {
      assertEquals(1, first.size)
      assertEquals(1, second.size)
      assertEquals(2L, second.single().sequence)
    }
  }

  @Test
  fun `replacing spec cancels requests and invalid replacement removes previous nodes`() {
    var cancelled = false
    val client = PrototypeHttpClient {
      try {
        awaitCancellation()
      } finally {
        cancelled = true
      }
    }
    val input = mutableStateOf(requestSpec())
    val network = PrototypeNetwork(client)
    compose.setContent { host.Content { AutoMobilePrototype(input.value, network = network) } }
    compose.onNodeWithTag("go").performClick()
    compose.runOnIdle { input.value = "{}" }
    compose.onNodeWithTag("go").assertDoesNotExist()
    compose.onNodeWithText("Cannot load prototype at", substring = true).assertIsDisplayed()
    compose.runOnIdle { assertTrue(cancelled) }
  }

  private fun storedSwitchSpec() =
    embeddedSpec(
      """{"type":"switch","testTag":"dark","label":"Dark","stateKey":"dark"}""",
      """"state":{"dark":false},"storage":{"version":1,"keys":["state:dark"]},""",
    )
}
