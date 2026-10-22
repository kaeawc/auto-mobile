package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.platform.LocalView
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.layout
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
  fun layoutFailureShowsCorruptWithBackInsteadOfCrashing() {
    renderer.layoutError = IllegalStateException("Broken spec layout")
    val activity = launch()
    assertCorruptWithWorkingBack(activity)
  }

  @Test
  fun drawFailureShowsCorruptWithBackInsteadOfCrashing() {
    renderer.drawError = IllegalStateException("Broken spec draw")
    val activity = launch()
    drawHierarchy(activity)
    assertCorruptWithWorkingBack(activity)
  }

  @Test
  fun stackOverflowDuringCompositionShowsCorruptWithBack() {
    renderer.compositionError = StackOverflowError()
    val activity = launch()
    assertCorruptWithWorkingBack(activity)
  }

  @Test
  fun stackOverflowDuringLayoutShowsCorruptWithBack() {
    renderer.layoutError = StackOverflowError()
    val activity = launch()
    assertCorruptWithWorkingBack(activity)
  }

  @Test
  fun stackOverflowDuringDrawShowsCorruptWithBack() {
    renderer.drawError = StackOverflowError()
    val activity = launch()
    drawHierarchy(activity)
    assertCorruptWithWorkingBack(activity)
  }

  @Test
  fun laterLayoutFailureRemovesSpecAndShowsBack() {
    launch()
    compose.onNodeWithText("Prototype content").assertIsDisplayed()
    compose.runOnIdle { renderer.layoutError = IllegalStateException("Broken spec layout") }
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
    compose.onNodeWithText("Prototype content").assertDoesNotExist()
    compose.onNodeWithText("Back").assertIsDisplayed()
  }

  // Robolectric never runs a draw pass on its own; force the traversal's draw of the window.
  private fun drawHierarchy(activity: ViewerActivity) {
    compose.runOnIdle {
      activity.window.decorView.draw(Canvas(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)))
    }
  }

  private fun assertCorruptWithWorkingBack(activity: ViewerActivity) {
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
    compose.onNodeWithText("Prototype content").assertDoesNotExist()
    assertTrue(timer.tasks.all { it.cancelled })
    compose.onNodeWithText("Back").performClick()
    assertTrue(activity.isFinishing)
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
  var compositionError: Throwable? by mutableStateOf(null)
  var layoutError: Throwable? by mutableStateOf(null)
  var drawError: Throwable? by mutableStateOf(null)
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
          }
          compositionError?.let { throw it }
          ReleaseTestExceptionHandler()
          Box(
            Modifier.fillMaxSize()
              .layout { measurable, constraints ->
                layoutError?.let { throw it }
                val placeable = measurable.measure(constraints)
                layout(placeable.width, placeable.height) { placeable.place(0, 0) }
              }
              .drawBehind { drawError?.let { throw it } },
          ) {
            content()
          }
        },
        onFailure = onFailure,
      )
  }
}

/**
 * The Compose test rule installs an uncaught-exception handler on every registered root, which
 * swallows measure failures before they reach the view traversal. Production roots have none, so
 * remove it from the isolated spec root to exercise the real view-level guard.
 */
@Composable
@OptIn(InternalComposeUiApi::class)
private fun ReleaseTestExceptionHandler() {
  val root = LocalView.current as? RootForTest
  SideEffect { root?.setUncaughtExceptionHandler(null) }
}
