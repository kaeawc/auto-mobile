package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController

@RunWith(RobolectricTestRunner::class)
class ViewerWatchdogTest {
  @get:Rule val compose = createComposeRule()
  private val repository = FakeLibraryRepository()
  private val settings = FakeSettingsStore()
  private val timer = FakeRenderTimer()
  private val renderer = FakeViewerRenderer()
  private var io: CoroutineDispatcher = UnconfinedTestDispatcher()
  private var controller: ActivityController<ViewerActivity>? = null

  @Before
  fun configure() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        repository,
        LibraryStorage(FakePrototypeStorage()),
        io,
        LibraryClock { 42 },
        settings = settings,
        renderWatchdog = DeadlineRenderWatchdog { timer },
        renderer = renderer,
      )
    }
  }

  @After
  fun close() {
    controller?.pause()?.stop()?.destroy()
  }

  private fun launch(): ViewerActivity {
    val context = ApplicationProvider.getApplicationContext<Context>()
    controller =
      Robolectric.buildActivity(ViewerActivity::class.java, ViewerLaunch.intent(context, FIRST))
        .setup()
    compose.waitForIdle()
    return checkNotNull(controller).get()
  }

  @Test
  fun neverReadyShowsCorruptAndWorkingBackAtDeadline() {
    renderer.waitForever = true
    val activity = launch()
    compose.runOnIdle { timer.advanceBy(RENDER_READY_BUDGET_MILLIS - 1) }
    compose.onNodeWithText("This prototype could not be opened.").assertDoesNotExist()
    compose.runOnIdle { timer.advanceBy(1) }
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
    compose.onNodeWithText("Back").performClick()
    assertTrue(activity.isFinishing)
  }

  @Test
  fun readyRenderCancelsWatchdogAndIgnoresLateExpiry() {
    launch()
    compose.onNodeWithText("Prototype content").assertIsDisplayed()
    compose.runOnIdle { timer.advanceBy(RENDER_READY_BUDGET_MILLIS) }
    compose.onNodeWithText("Prototype content").assertIsDisplayed()
    assertEquals(1, timer.tasks.size)
    assertTrue(timer.tasks.all { it.cancelled })
  }

  @Test
  fun compositionFailureShowsCorruptWithBackInsteadOfRetrying() {
    renderer.throwDuringComposition = true
    val activity = launch()
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
    assertEquals(1, timer.tasks.size)
    assertTrue(timer.tasks.all { it.cancelled })
    compose.onNodeWithText("Back").performClick()
    assertTrue(activity.isFinishing)
  }

  @Test
  fun laterRecompositionFailureRemovesSpecAndShowsBack() {
    launch()
    compose.onNodeWithText("Prototype content").assertIsDisplayed()
    compose.runOnIdle { renderer.throwDuringComposition = true }
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
    compose.onNodeWithText("Prototype content").assertDoesNotExist()
    compose.onNodeWithText("Back").assertIsDisplayed()
    assertEquals(1, renderer.failures)
  }

  @Test
  fun lateLibraryLoadCannotResurrectExpiredRender() {
    val pendingIo = StandardTestDispatcher()
    io = pendingIo
    launch()
    compose.runOnIdle { timer.advanceBy(RENDER_READY_BUDGET_MILLIS) }
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
    compose.runOnIdle { pendingIo.scheduler.runCurrent() }
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
    compose.onNodeWithText("Prototype content").assertDoesNotExist()
  }

  @Test
  fun destroyCancelsPendingWatchdog() {
    renderer.waitForever = true
    launch()
    controller?.pause()?.stop()?.destroy()
    controller = null
    assertEquals(1, timer.tasks.size)
    assertTrue(timer.tasks.all { it.cancelled })
    timer.advanceBy(RENDER_READY_BUDGET_MILLIS)
  }

  @Test
  fun relaunchCancelsPendingWatchdog() {
    renderer.waitForever = true
    val activity = launch()
    compose.onNodeWithText("Relaunch").performClick()
    assertTrue(activity.isFinishing)
    assertEquals(1, timer.tasks.size)
    assertTrue(timer.tasks.all { it.cancelled })
  }
}

private class FakeViewerRenderer : ViewerRenderer {
  var waitForever = false
  var throwDuringComposition by mutableStateOf(false)
  var failures = 0

  @androidx.compose.runtime.Composable
  override fun Render(
    content: @androidx.compose.runtime.Composable () -> Unit,
    onFailure: () -> Unit,
  ) {
    if (!waitForever)
      GuardedViewerRenderer.Render(
        content = {
          if (throwDuringComposition) {
            failures++
            error("Broken spec composition")
          } else content()
        },
        onFailure = onFailure,
      )
  }
}
