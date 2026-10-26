package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeDismissAction
import dev.jasonpearson.automobile.protocol.PrototypeEmitAction
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypePushAction
import dev.jasonpearson.automobile.protocol.PrototypeRequestAction
import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeRequests
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import dev.jasonpearson.automobile.protocol.PrototypeStorageBlock
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.protocol.PrototypeSwitchNode
import dev.jasonpearson.automobile.protocol.PrototypeToggleAction
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController

@RunWith(RobolectricTestRunner::class)
class SavedPrototypeActivityTest {
  // Own Compose's frame clock and effect scheduler, as in PrototypeRecompositionTest. Advancing
  // Robolectric's Looper alone does not synchronize RuntimeContent's interaction queue drain.
  @get:Rule val compose = createComposeRule()

  private val store = FakeSavedPrototypeStore()
  private val controllers = mutableListOf<ActivityController<SavedPrototypeActivity>>()
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Before
  fun configure() {
    SavedPrototypeActivityDependencies.store = { store }
    SavedPrototypeActivityDependencies.isUserUnlocked = { true }
    SavedPrototypeActivityDependencies.ioDispatcher = Dispatchers.Unconfined
    SavedPrototypeActivityDependencies.clock = { 42L }
    SavedPrototypeEvents.reset()
    store.stored["panel"] = savedPrototypeFixture()
  }

  @After
  fun reset() {
    controllers.forEach { it.pause().stop().destroy() }
    SavedPrototypeActivityDependencies.reset()
    SavedPrototypeEvents.reset()
  }

  private fun launch(
    intent: Intent = SavedPrototypeLaunch.intent(context, "panel"),
  ): SavedPrototypeActivity {
    val controller = Robolectric.buildActivity(SavedPrototypeActivity::class.java, intent).setup()
    controllers += controller
    compose.waitForIdle()
    return controller.get()
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  private fun root(activity: SavedPrototypeActivity): SemanticsNode =
    (checkNotNull(composeView(activity.window.decorView)) as RootForTest)
      .semanticsOwner
      .rootSemanticsNode

  private fun SemanticsNode.find(tag: String): SemanticsNode? =
    if (config.contains(SemanticsProperties.TestTag) && config[SemanticsProperties.TestTag] == tag)
      this
    else children.firstNotNullOfOrNull { it.find(tag) }

  private fun click(activity: SavedPrototypeActivity, tag: String) {
    assertNotNull(root(activity).find(tag))
    compose.onNodeWithTag(tag).performClick()
    compose.waitForIdle()
  }

  @Test
  fun `renders saved content without creating any accessibility service`() {
    // Only buildActivity is used: no CtrlProxy service is created or bound.
    val activity = launch()
    assertNotNull(root(activity).find("saved-node"))
    assertFalse(activity.isFinishing)
    assertEquals(listOf("panel"), store.loadCalls)
  }

  @Test
  fun `back finishes and buffers exactly one user dismissal`() {
    val activity = launch()
    activity.onBackPressedDispatcher.onBackPressed()
    activity.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    assertUserDismissed(activity)
  }

  @Test
  fun `activity back pops the saved stack before dismissing at root`() = runBlocking {
    val original = savedPrototypeFixture()
    val spec =
      original.spec.copy(
        motion = "none",
        root =
          PrototypeStackNode(
            id = "nav",
            start = "home",
            screens =
              mapOf(
                "home" to original.spec.root,
                "detail" to PrototypeButtonNode(label = "Detail", testTag = "detail"),
              ),
          ),
      )
    store.stored["panel"] =
      SavedPrototypeLoadResult.Loaded(
        original.id,
        original.label,
        original.slug,
        original.savedAt,
        spec,
        "",
        emptyMap(),
      )
    val activity = launch()
    activity.interact(PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))))
    compose.waitForIdle()
    assertNotNull(root(activity).find("detail"))
    SavedPrototypeEvents.buffer.drain()
    activity.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    assertFalse(activity.isFinishing)
    assertNotNull(root(activity).find("saved-node"))
    assertEquals(
      listOf(PrototypeEventKind.SCREEN_CHANGED),
      SavedPrototypeEvents.buffer.drain().map { it.kind },
    )
    activity.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    assertUserDismissed(activity)
  }

  @Test
  fun `authored dismiss finishes and buffers one user dismissal`() {
    store.stored["panel"] = savedPrototypeFixture(actions = listOf(PrototypeDismissAction))
    val activity = launch()
    click(activity, "saved-node")
    assertTrue(activity.isFinishing)
    activity.onBackPressedDispatcher.onBackPressed()
    assertUserDismissed(activity)
  }

  @Test
  fun `host dismiss finishes and buffers one user dismissal`() = runBlocking {
    val activity = launch()
    activity.interact(PrototypeInteraction.HostDismiss)
    activity.onBackPressedDispatcher.onBackPressed()
    assertUserDismissed(activity)
  }

  private fun assertUserDismissed(activity: SavedPrototypeActivity) {
    assertTrue(activity.isFinishing)
    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(1, events.size)
    assertEquals(PrototypeEventKind.DISMISSED, events.single().kind)
    assertEquals("user", events.single().payload?.jsonObject?.get("reason")?.jsonPrimitive?.content)
  }

  @Test
  fun `renderer interactions buffer offline in order with fake time and sequence`() {
    val activity = launch()
    click(activity, "saved-node")
    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf("first", "second"), events.map { it.name })
    assertEquals(listOf(1L, 2L), events.map { it.sequence })
    assertEquals(listOf(42L, 42L), events.map { it.timestamp })
  }

  @Test
  fun `second activity instance continues the same prototype sequence`() {
    val first = launch()
    click(first, "saved-node")
    controllers.removeAt(0).pause().stop().destroy()
    compose.waitForIdle()

    val second = launch()
    click(second, "saved-node")
    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf("panel", "panel", "panel", "panel"), events.map { it.id })
    assertEquals(listOf(1L, 2L, 3L, 4L), events.map { it.sequence })
    assertEquals(listOf("first", "second", "first", "second"), events.map { it.name })
    assertEquals(listOf(42L, 42L, 42L, 42L), events.map { it.timestamp })
  }

  @Test
  fun `document relaunch reloads replaced content without a dismissal`() {
    val activity = launch()
    click(activity, "saved-node")
    val original = store.stored.getValue("panel")
    val button = original.spec.root as PrototypeButtonNode
    store.stored["panel"] =
      SavedPrototypeLoadResult.Loaded(
        original.id,
        original.label,
        original.slug,
        original.savedAt,
        original.spec.copy(
          root =
            button.copy(label = "Updated button", onTap = listOf(PrototypeEmitAction("updated"))),
        ),
        "",
        emptyMap(),
      )
    val intent = SavedPrototypeLaunch.intent(context, "panel")
    controllers.single().newIntent(intent)
    compose.waitForIdle()

    assertEquals(intent, activity.intent)
    assertTrue(root(activity).hasText("Updated button"))
    assertFalse(root(activity).hasText("Saved button"))
    assertFalse(activity.isFinishing)
    assertEquals(listOf("panel", "panel"), store.loadCalls)
    click(activity, "saved-node")
    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf("first", "second", "updated"), events.map { it.name })
    assertEquals(
      listOf(PrototypeEventKind.EMIT, PrototypeEventKind.EMIT, PrototypeEventKind.EMIT),
      events.map { it.kind },
    )
    assertEquals(listOf(1L, 2L, 3L), events.map { it.sequence })
  }

  @Test
  fun `document relaunch of identical spec still replaces runtime and continues sequence`() {
    val fixture = savedPrototypeFixture(actions = listOf(PrototypeToggleAction("dark")))
    store.stored["panel"] =
      SavedPrototypeLoadResult.Loaded(
        fixture.id,
        fixture.label,
        fixture.slug,
        fixture.savedAt,
        fixture.spec.copy(state = mapOf("dark" to PrototypeScalar.BooleanValue(false))),
        fixture.specJson,
        emptyMap(),
      )
    val activity = launch()
    click(activity, "saved-node")
    controllers.single().newIntent(SavedPrototypeLaunch.intent(context, "panel"))
    compose.waitForIdle()
    assertEquals(1, SavedPrototypeEvents.buffer.size)
    click(activity, "saved-node")

    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf(1L, 2L), events.map { it.sequence })
    assertEquals(listOf(PrototypeEventKind.EMIT, PrototypeEventKind.EMIT), events.map { it.kind })
    assertEquals(listOf("change", "change"), events.map { it.name })
    // Both toggles start from the saved false value, rather than retaining the old runtime's true.
    assertEquals(events.first().payload, events.last().payload)
    assertFalse(activity.isFinishing)
  }

  @Test
  fun `suspending injected sink is awaited between events without default delivery`() =
    runBlocking {
      val gate = CompletableDeferred<Unit>()
      val events = mutableListOf<PrototypeEvent>()
      SavedPrototypeActivityDependencies.eventSink = PrototypeEventSink {
        events += it
        if (events.size == 1) gate.await()
      }
      val activity = launch()
      val button = store.stored.getValue("panel").spec.root as PrototypeButtonNode
      val interaction =
        launch(start = CoroutineStart.UNDISPATCHED) {
          activity.interact(PrototypeInteraction.Tap(checkNotNull(button.onTap)))
        }
      assertEquals(listOf("first"), events.map { it.name })
      assertFalse(interaction.isCompleted)
      gate.complete(Unit)
      interaction.join()
      assertTrue(interaction.isCompleted)
      assertEquals(listOf("first", "second"), events.map { it.name })
      assertEquals(listOf(1L, 2L), events.map { it.sequence })
      assertEquals(0, SavedPrototypeEvents.buffer.size)
    }

  @Test
  fun `document relaunch of a deleted entry shows not saved and closes without an event`() {
    val activity = launch()
    assertTrue(store.delete("panel"))
    controllers.single().newIntent(SavedPrototypeLaunch.intent(context, "panel"))
    compose.waitForIdle()

    assertEquals(listOf("panel", "panel"), store.loadCalls)
    assertFalse(root(activity).hasText("Saved button"))
    assertErrorCloses(activity, "not-saved", "This prototype is no longer saved")
  }

  @Test
  fun `new intent for another id reloads and uses an independent sequence`() {
    val activity = launch()
    click(activity, "saved-node")
    store.stored["other"] =
      savedPrototypeFixture(id = "other", actions = listOf(PrototypeEmitAction("other")))
    val intent = SavedPrototypeLaunch.intent(context, "other")
    controllers.single().newIntent(intent)
    compose.waitForIdle()

    assertEquals(intent, activity.intent)
    assertEquals(listOf("panel", "other"), store.loadCalls)
    assertFalse(activity.isFinishing)
    click(activity, "saved-node")
    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf("panel", "panel", "other"), events.map { it.id })
    assertEquals(listOf("first", "second", "other"), events.map { it.name })
    assertEquals(listOf(1L, 2L, 1L), events.map { it.sequence })
  }

  @Test
  fun `direct tap buffers fixture actions in order with fake time and sequence`() = runBlocking {
    val activity = launch()
    val button = store.stored.getValue("panel").spec.root as PrototypeButtonNode
    activity.interact(PrototypeInteraction.Tap(checkNotNull(button.onTap)))
    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf("first", "second"), events.map { it.name })
    assertEquals(listOf(PrototypeEventKind.EMIT, PrototypeEventKind.EMIT), events.map { it.kind })
    assertEquals(listOf(1L, 2L), events.map { it.sequence })
    assertEquals(listOf(42L, 42L), events.map { it.timestamp })
  }

  @Test
  fun `request via device uses the injected transport with no host connection`() = runBlocking {
    val seen = CompletableDeferred<PrototypeHttpRequest>()
    val device = PrototypeHttpClient { request ->
      seen.complete(request)
      PrototypeRequestResponse.Failed(
        PrototypeRequestError(PrototypeRequestErrorCode.NETWORK, "fake device transport"),
      )
    }
    SavedPrototypeActivityDependencies.httpClients = {
      PrototypeHttpClients.forSavedPrototype(device)
    }
    store.stored["panel"] =
      savedPrototypeFixture(
        actions =
          listOf(PrototypeRequestAction(url = "http://localhost:8080/feed", via = "device")),
      )
    launch()
    click(activity = controllers.single().get(), tag = "saved-node")
    val request = withTimeout(5_000) { seen.await() }
    assertEquals("http://localhost:8080/feed", request.url)
    assertEquals("panel", request.prototypeId)
  }

  @Test
  fun `request via host fails with an explicit saved prototype error`() = runBlocking {
    val response =
      PrototypeHttpClients.forSavedPrototype { error("device not used") }
        .forVia(PrototypeHttpClients.VIA_HOST)
        .execute(PrototypeHttpRequest("r", "panel", "GET", "http://h/", emptyMap(), null, 1_000))
    val error = (response as PrototypeRequestResponse.Failed).error
    assertEquals(PrototypeRequestErrorCode.INVALID_REQUEST, error.code)
    assertEquals(PrototypeHttpClients.SAVED_HOST_UNAVAILABLE_MESSAGE, error.message)
    assertTrue(error.message.contains("saved prototypes"))
  }

  @Test
  fun `public embedding wiring preserves the saved host refusal outcome`() {
    SavedPrototypeActivityDependencies.httpClients = {
      PrototypeHttpClients.forSavedPrototype { error("Host requests must never use the device") }
    }
    savedRequestPrototype("host")
    val activity = launch()
    click(activity, "saved-node")

    val payload =
      SavedPrototypeEvents.buffer
        .drain()
        .single { it.name == PrototypeRequests.EVENT_NAME }
        .payload!!
        .jsonObject
    assertEquals(JsonPrimitive("host"), payload["via"])
    assertEquals(JsonPrimitive("error"), payload["outcome"])
    val failure = payload.getValue("error").jsonObject
    assertEquals(
      JsonPrimitive(PrototypeRequestErrorCode.INVALID_REQUEST.wireValue),
      failure["code"],
    )
    assertEquals(
      JsonPrimitive(PrototypeHttpClients.SAVED_HOST_UNAVAILABLE_MESSAGE),
      failure["message"],
    )
  }

  @Test
  fun `corrupt stored values are deleted when opening through public storage adapter`() {
    val storage = FakePrototypeStorageStore()
    storage.documents["panel"] = PrototypeStorageLoad.Corrupt("unreadable")
    SavedPrototypeActivityDependencies.storageStore = { storage }
    val activity = launch()
    assertNotNull(root(activity).find("saved-node"))
    assertEquals(listOf("panel"), storage.deletes)
    assertEquals(0, SavedPrototypeEvents.buffer.size)
  }

  @Test
  fun `storage restores before drawing and reload flushes before the replacement restores`() {
    val storage = FakePrototypeStorageStore()
    storage.seed("panel", PrototypeStoredValues(1, mapOf("state:dark" to JsonPrimitive(true))))
    SavedPrototypeActivityDependencies.storageStore = { storage }
    savedStoragePrototype()
    val activity = launch()
    compose.onNodeWithTag("saved-node").assertIsOn()
    assertEquals(0, SavedPrototypeEvents.buffer.size)
    click(activity, "saved-node")
    compose.onNodeWithTag("saved-node").assertIsOff()

    controllers.single().newIntent(SavedPrototypeLaunch.intent(context, "panel"))
    compose.waitForIdle()
    compose.onNodeWithTag("saved-node").assertIsOff()
    assertEquals(JsonPrimitive(false), storage.stored("panel")?.values?.get("state:dark"))
    assertEquals(1, SavedPrototypeEvents.buffer.size)
  }

  @Test
  fun `shared registry invalidation prevents the embedded saved session from recreating storage`() =
    runBlocking {
      val storage = FakePrototypeStorageStore()
      SavedPrototypeActivityDependencies.storageStore = { storage }
      SavedPrototypeActivityDependencies.flushScope = this
      savedStoragePrototype()
      val activity = launch()
      assertTrue(PrototypeStorageSessionRegistry.Shared.invalidate("panel") > 0)
      click(activity, "saved-node")
      controllers.removeAt(0).pause().stop().destroy()
      yield()
      assertTrue(storage.saves.isEmpty())
    }

  private fun savedStoragePrototype() {
    val fixture = savedPrototypeFixture()
    store.stored["panel"] =
      SavedPrototypeLoadResult.Loaded(
        fixture.id,
        fixture.label,
        fixture.slug,
        fixture.savedAt,
        fixture.spec.copy(
          state = mapOf("dark" to PrototypeScalar.BooleanValue(false)),
          storage = PrototypeStorageBlock(1, listOf("state:dark")),
          root = PrototypeSwitchNode(testTag = "saved-node", label = "Dark", stateKey = "dark"),
        ),
        fixture.specJson,
        emptyMap(),
      )
  }

  @Test
  fun `connected delivery consumes events and refused delivery falls back`() {
    val delivered = mutableListOf<PrototypeEvent>()
    SavedPrototypeEvents.delivery = SavedPrototypeEventDelivery {
      delivered += it
      true
    }
    val activity = launch()
    click(activity, "saved-node")
    assertEquals(listOf("first", "second"), delivered.map { it.name })
    assertEquals(listOf(1L, 2L), delivered.map { it.sequence })
    assertEquals(listOf(42L, 42L), delivered.map { it.timestamp })
    assertEquals(0, SavedPrototypeEvents.buffer.size)
    SavedPrototypeEvents.delivery = SavedPrototypeEventDelivery { false }
    click(activity, "saved-node")
    val buffered = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf("first", "second"), buffered.map { it.name })
    assertEquals(listOf(3L, 4L), buffered.map { it.sequence })
    assertEquals(listOf(42L, 42L), buffered.map { it.timestamp })
    assertEquals(listOf("first", "second"), delivered.map { it.name })
  }

  @Test
  fun `throwing delivery preserves events for replay`() {
    SavedPrototypeEvents.delivery = SavedPrototypeEventDelivery { error("Disconnected") }
    val activity = launch()
    click(activity, "saved-node")
    val events = SavedPrototypeEvents.buffer.drain()
    assertEquals(listOf("first", "second"), events.map { it.name })
    assertEquals(listOf(1L, 2L), events.map { it.sequence })
    assertEquals(listOf(42L, 42L), events.map { it.timestamp })
  }

  private fun assertErrorCloses(activity: SavedPrototypeActivity, tag: String, title: String) {
    val tree = root(activity)
    assertNotNull(tree.find("saved-prototype-state-$tag"))
    assertTrue(tree.hasText(title))
    click(activity, "saved-prototype-close")
    assertTrue(activity.isFinishing)
    assertEquals(0, SavedPrototypeEvents.buffer.size)
  }

  private fun SemanticsNode.hasText(text: String): Boolean =
    (config.contains(SemanticsProperties.Text) &&
      config[SemanticsProperties.Text].any { it.text == text }) || children.any { it.hasText(text) }

  @Test
  fun `not saved shows a typed screen and close finishes`() {
    store.loadResult = SavedPrototypeLoadResult.NotFound
    assertErrorCloses(launch(), "not-saved", "This prototype is no longer saved")
  }

  @Test
  fun `corrupt shows a typed screen and close finishes`() {
    store.loadResult = SavedPrototypeLoadResult.Corrupt("secret path")
    val activity = launch()
    assertFalse(root(activity).hasText("secret path"))
    assertErrorCloses(activity, "corrupt", "This saved prototype can't be opened")
  }

  @Test
  fun `unsupported shows a typed screen and version only`() {
    store.loadResult = SavedPrototypeLoadResult.UnsupportedFormat(7)
    val activity = launch()
    assertTrue(root(activity).hasText("Saved format version: 7"))
    assertErrorCloses(activity, "unsupported", "This prototype was saved by a newer version")
  }

  @Test
  fun `locked never constructs a store and close finishes`() {
    SavedPrototypeActivityDependencies.isUserUnlocked = { false }
    SavedPrototypeActivityDependencies.store = { error("Locked storage must not be accessed") }
    assertErrorCloses(launch(), "locked", "Unlock your device to open this prototype")
    assertTrue(store.loadCalls.isEmpty())
  }

  @Test
  fun `missing id shows a typed screen and close finishes`() {
    val activity = launch(Intent(context, SavedPrototypeActivity::class.java))
    assertErrorCloses(activity, "missing-id", "No prototype was selected")
    assertTrue(store.loadCalls.isEmpty())
  }

  @Test
  fun `back on an error screen finishes without emitting a runtime event`() {
    store.loadResult = SavedPrototypeLoadResult.NotFound
    val activity = launch()
    activity.onBackPressedDispatcher.onBackPressed()
    assertTrue(activity.isFinishing)
    assertEquals(0, SavedPrototypeEvents.buffer.size)
  }

  /** Passes io work straight through until [hold], then queues it for the test to release. */
  private class GatedDispatcher : CoroutineDispatcher() {
    var hold = false
    val queue = ArrayDeque<Runnable>()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
      if (hold) queue.addLast(block) else block.run()
    }
  }

  @Test
  fun `loading stays visible until stored state is ready for its first draw`() {
    val gate = GatedDispatcher()
    val storage = FakePrototypeStorageStore()
    storage.seed("panel", PrototypeStoredValues(1, mapOf("state:dark" to JsonPrimitive(true))))
    savedStoragePrototype()
    SavedPrototypeActivityDependencies.ioDispatcher = gate
    SavedPrototypeActivityDependencies.storageStore = { storage }
    SavedPrototypeActivityDependencies.store = {
      object : SavedPrototypeStore by store {
        override fun load(id: String): SavedPrototypeLoadResult =
          store.load(id).also { gate.hold = true }
      }
    }
    val activity = launch()
    try {
      assertNotNull(root(activity).find("saved-prototype-state-loading"))
      assertNull(root(activity).find("saved-prototype-state-ready"))
      assertNull(root(activity).find("saved-node"))
    } finally {
      gate.hold = false
      while (gate.queue.isNotEmpty()) gate.queue.removeFirst().run()
    }
    compose.waitForIdle()
    compose.onNodeWithTag("saved-node").assertIsOn()
    assertNotNull(root(activity).find("saved-prototype-state-ready"))
    assertNull(root(activity).find("saved-prototype-state-loading"))
    assertEquals(0, SavedPrototypeEvents.buffer.size)
  }

  @Test
  fun `a stop followed straight by a destroy still saves the stored values`() = runBlocking {
    val gate = GatedDispatcher()
    val storage = FakePrototypeStorageStore()
    SavedPrototypeActivityDependencies.ioDispatcher = gate
    SavedPrototypeActivityDependencies.storageStore = { storage }
    SavedPrototypeActivityDependencies.flushScope = CoroutineScope(Dispatchers.Unconfined)
    val fixture = savedPrototypeFixture(actions = listOf(PrototypeToggleAction("dark")))
    store.stored["panel"] =
      SavedPrototypeLoadResult.Loaded(
        fixture.id,
        fixture.label,
        fixture.slug,
        fixture.savedAt,
        fixture.spec.copy(
          state = mapOf("dark" to PrototypeScalar.BooleanValue(false)),
          storage = PrototypeStorageBlock(1, listOf("state:dark")),
        ),
        fixture.specJson,
        emptyMap(),
      )
    val controller =
      Robolectric.buildActivity(
          SavedPrototypeActivity::class.java,
          SavedPrototypeLaunch.intent(context, "panel"),
        )
        .setup()
    compose.waitForIdle()
    val button = store.stored.getValue("panel").spec.root as PrototypeButtonNode
    controller.get().interact(PrototypeInteraction.Tap(checkNotNull(button.onTap)))

    gate.hold = true
    controller.pause().stop()
    controller.destroy()
    gate.hold = false
    while (gate.queue.isNotEmpty()) gate.queue.removeFirst().run()

    assertEquals(
      PrototypeStoredValues(1, mapOf("state:dark" to JsonPrimitive(true))),
      storage.stored("panel"),
    )
  }

  /** Records each request; answers at once, or waits until cancelled when [hold] is set. */
  private class RecordingHttp(private val hold: Boolean = false) : PrototypeHttpClient {
    val requests = mutableListOf<PrototypeHttpRequest>()
    var cancelled = false

    override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
      requests += request
      if (!hold) return PrototypeRequestResponse.Received(200, emptyMap(), JsonPrimitive("ok"), 1)
      try {
        awaitCancellation()
      } catch (error: CancellationException) {
        cancelled = true
        throw error
      }
    }
  }

  private fun savedRequestPrototype(via: String) {
    val fixture =
      savedPrototypeFixture(
        actions =
          listOf(
            Json.decodeFromString(
              PrototypeAction.serializer(),
              """{"type":"request","url":"http://localhost:8080/x","via":"$via"}""",
            ),
          ),
      )
    store.stored["panel"] = fixture
  }

  private fun tapSaved(activity: SavedPrototypeActivity) = runBlocking {
    val button = store.stored.getValue("panel").spec.root as PrototypeButtonNode
    activity.interact(PrototypeInteraction.Tap(checkNotNull(button.onTap)))
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test
  fun `destroying the activity cancels a request in flight`() {
    val device = RecordingHttp(hold = true)
    SavedPrototypeActivityDependencies.httpClients = { PrototypeHttpClients(device, device) }
    savedRequestPrototype("device")
    val controller =
      Robolectric.buildActivity(
          SavedPrototypeActivity::class.java,
          SavedPrototypeLaunch.intent(context, "panel"),
        )
        .setup()
    compose.waitForIdle()
    tapSaved(controller.get())
    assertEquals(1, device.requests.size)

    controller.pause().stop().destroy()
    shadowOf(Looper.getMainLooper()).idle()

    assertTrue(device.cancelled)
  }
}
