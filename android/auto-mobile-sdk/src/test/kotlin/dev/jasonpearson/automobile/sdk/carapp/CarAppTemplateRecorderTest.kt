package dev.jasonpearson.automobile.sdk.carapp

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.ScreenManager
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.testing.TestCarContext
import androidx.lifecycle.Lifecycle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class CarAppTemplateRecorderTest {
  private lateinit var carContext: TestCarContext
  private lateinit var recorder: CarAppTemplateRecorder

  @Before
  fun setUp() {
    carContext = TestCarContext.createCarContext(RuntimeEnvironment.getApplication())
    // Screens follow the car app's lifecycle; a started app lets pushed screens be popped.
    carContext.lifecycleOwner.registry.currentState = Lifecycle.State.RESUMED
    recorder = CarAppTemplateRecorder(InlineMainThread)
    recorder.enabled = true
  }

  @Test
  fun `walks the stack root first and reports each screen's recorded template`() {
    val root = FixedScreen(carContext, message("Welcome"))
    val detail = FixedScreen(carContext, list("Songs", "Track 1"))
    detail.marker = "detail"
    push(root, detail)
    recorder.record(root, root.onGetTemplate())
    recorder.record(detail, detail.onGetTemplate())

    val document = recorder.snapshot()

    assertTrue(document.enabled)
    val session = document.sessions.single()
    assertEquals("session0", session.id)
    assertEquals(listOf("session0/screen0", "session0/screen1"), session.screens.map { it.id })
    assertEquals(listOf(false, true), session.screens.map { it.top })
    assertEquals("MessageTemplate", session.screens[0].template?.type)
    assertEquals("Welcome", session.screens[0].template?.message)
    val top = session.screens[1]
    assertEquals("detail", top.marker)
    assertEquals(FixedScreen::class.java.name, top.screenClass)
    assertEquals("ListTemplate", top.template?.type)
    assertEquals("Songs", top.template?.title)
    assertEquals("session0/screen1/template/items/0", top.template?.items?.single()?.id)
  }

  @Test
  fun `a stacked screen that never recorded a template is reported without one`() {
    val root = FixedScreen(carContext, message("Root"))
    val top = FixedScreen(carContext, message("Top"))
    push(root, top)
    recorder.record(top, top.onGetTemplate())

    val screens = recorder.snapshot().sessions.single().screens

    assertNull(screens[0].template)
    assertEquals("Top", screens[1].template?.message)
  }

  @Test
  fun `nested ids carry the screen's stack position`() {
    val root = FixedScreen(carContext, message("Root"))
    val top = FixedScreen(carContext, message("Top"))
    push(root, top)
    recorder.record(top, top.onGetTemplate())

    val template = recorder.snapshot().sessions.single().screens[1].template!!

    assertEquals("session0/screen1/template", template.id)
    assertEquals("session0/screen1/template/header/actions/0", template.headerActions.single().id)
  }

  @Test
  fun `the latest recorded template replaces the earlier one`() {
    val screen = FixedScreen(carContext, message("First"))
    push(screen)
    recorder.record(screen, message("First"))
    recorder.record(screen, message("Second"))

    assertEquals("Second", recorder.snapshot().sessions.single().screens.single().template?.message)
  }

  @Test
  fun `a popped screen leaves the reported stack`() {
    val root = FixedScreen(carContext, message("Root"))
    val top = FixedScreen(carContext, message("Top"))
    push(root, top)
    recorder.record(root, root.onGetTemplate())
    recorder.record(top, top.onGetTemplate())

    carContext.getCarService(ScreenManager::class.java).pop()

    val screens = recorder.snapshot().sessions.single().screens
    assertEquals(listOf("Root"), screens.map { it.template?.message })
    assertTrue(screens.single().top)
  }

  @Test
  fun `a main thread timeout is reported instead of thrown`() {
    val stalled =
      CarAppTemplateRecorder(
        object : MainThreadRunner {
          override fun <T> run(block: () -> T): T = throw IllegalStateException(MAIN_THREAD_TIMEOUT)
        },
      )
    stalled.enabled = true

    val document = stalled.snapshot()

    assertTrue(document.enabled)
    assertEquals(MAIN_THREAD_TIMEOUT, document.error)
    assertTrue(document.sessions.isEmpty())
  }

  @Test
  fun `a push and record during the walk are reported together`() {
    val root = FixedScreen(carContext, message("Root"))
    push(root)
    val pushed = FixedScreen(carContext, message("Pushed"))
    lateinit var walking: CarAppTemplateRecorder
    walking =
      CarAppTemplateRecorder(
        object : MainThreadRunner {
          override fun <T> run(block: () -> T): T {
            // Stands in for onGetTemplate() landing on the main thread just before the walk: the
            // copy has to happen inside the walk, or this screen is reported without its template.
            push(pushed)
            walking.record(pushed, message("Pushed"))
            return block()
          }
        },
      )
    walking.enabled = true
    walking.record(root, root.onGetTemplate())

    val screens = walking.snapshot().sessions.single().screens

    assertEquals(listOf("Root", "Pushed"), screens.map { it.template?.message })
  }

  @Test
  fun `record stores nothing once recording is turned off`() {
    val screen = FixedScreen(carContext, message("Racing"))
    push(screen)
    recorder.enabled = false

    recorder.record(screen, screen.onGetTemplate())

    // Recording back on, so the empty snapshot is the dropped write and not a disabled recorder.
    recorder.enabled = true
    assertTrue(recorder.snapshot().sessions.isEmpty())
  }

  @Test
  fun `clear forgets every recorded screen`() {
    val screen = FixedScreen(carContext, message("Gone"))
    push(screen)
    recorder.record(screen, screen.onGetTemplate())

    recorder.clear()

    assertTrue(recorder.snapshot().sessions.isEmpty())
  }

  @Test
  fun `the route answers disabled until enable installs a source`() {
    CarAppTemplateRoute.source = null
    val disabled = decodeCarAppTemplateDocument(CarAppTemplateRoute.snapshotJson())
    assertFalse(disabled.enabled)
    assertTrue(disabled.sessions.isEmpty())

    val screen = FixedScreen(carContext, message("Hi"))
    push(screen)
    recorder.record(screen, screen.onGetTemplate())
    CarAppTemplateRoute.source = recorder::snapshot
    try {
      val enabled = decodeCarAppTemplateDocument(CarAppTemplateRoute.snapshotJson())
      assertTrue(enabled.enabled)
      assertEquals("Hi", enabled.sessions.single().screens.single().template?.message)
    } finally {
      CarAppTemplateRoute.source = null
    }
  }

  @Test
  fun `record returns its argument and stores nothing while the facade is disabled`() {
    AutoMobileCarAppTemplates.disable()
    val screen = FixedScreen(carContext, message("Off"))
    val template = message("Off")

    assertSame(template, AutoMobileCarAppTemplates.record(screen, template))
    assertFalse(decodeCarAppTemplateDocument(CarAppTemplateRoute.snapshotJson()).enabled)
  }

  private fun push(vararg screens: Screen) {
    val manager = carContext.getCarService(ScreenManager::class.java)
    screens.forEach { manager.push(it) }
  }

  private fun message(text: String): MessageTemplate =
    MessageTemplate.Builder(text).setTitle("Title").setHeaderAction(Action.BACK).build()

  private fun list(title: String, row: String): ListTemplate =
    ListTemplate.Builder()
      .setTitle(title)
      .setSingleList(ItemList.Builder().addItem(Row.Builder().setTitle(row).build()).build())
      .build()

  private class FixedScreen(carContext: CarContext, private val template: Template) :
    Screen(carContext) {
    override fun onGetTemplate(): Template = template
  }

  private object InlineMainThread : MainThreadRunner {
    override fun <T> run(block: () -> T): T = block()
  }
}
