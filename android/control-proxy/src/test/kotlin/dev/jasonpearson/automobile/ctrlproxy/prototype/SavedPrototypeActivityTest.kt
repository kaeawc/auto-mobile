package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeDismissAction
import dev.jasonpearson.automobile.protocol.PrototypeEmitAction
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
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
}
