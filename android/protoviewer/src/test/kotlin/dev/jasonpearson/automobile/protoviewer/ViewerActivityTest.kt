package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController

@RunWith(RobolectricTestRunner::class)
class ViewerActivityTest {
  @get:Rule val compose = createComposeRule()
  private val repository = FakeLibraryRepository()
  private val settings = FakeSettingsStore()
  private var controller: ActivityController<ViewerActivity>? = null

  @Before
  fun configure() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        repository,
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        LibraryClock { 42 },
        settings = settings,
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
  fun loadsPrototypeAndMarksOpened() {
    launch()
    compose.onNodeWithText("Prototype content").assertIsDisplayed()
    assertEquals(listOf(FIRST), repository.opened)
  }

  @Test
  fun chromelessFullscreenContentHasNoHostBarInset() {
    assertWindowChromeContentStartsAtViewerTop("none")
  }

  @Test
  fun fullscreenBarDoesNotDuplicateViewerActions() {
    assertWindowChromeContentStartsAtViewerTop("bar")
  }

  private fun assertWindowChromeContentStartsAtViewerTop(chrome: String) {
    val specJson =
      """{"id":"chrome","window":{"placement":{"type":"fullscreen"},"chrome":"$chrome"},"root":{"type":"text","text":"Prototype content"}}"""
    val spec = (PrototypeSpecValidator.validate(specJson) as PrototypeSpecValidation.Success).spec
    repository.prototypes[FIRST] =
      LibraryPrototype(
        Fixtures.entry(),
        SavedPrototypeLoadResult.Loaded(FIRST, "Example", "slug", 10, spec, specJson, emptyMap()),
      )
    launch()
    val actions = compose.onNodeWithTag("viewer-actions").getUnclippedBoundsInRoot()
    val content = compose.onNodeWithTag("viewer-content").getUnclippedBoundsInRoot()
    val text =
      compose.onNodeWithText("Prototype content").assertIsDisplayed().getUnclippedBoundsInRoot()
    assertTrue(actions.bottom > actions.top)
    assertEquals(actions.bottom.value, content.top.value, 0.01f)
    assertEquals(0f, text.top.value, 0.01f)
  }

  @Test
  fun notFoundShowsErrorAndBack() {
    repository.prototypes.clear()
    val activity = launch()
    compose.onNodeWithText("Prototype not found.").assertIsDisplayed()
    compose.onNodeWithText("Back").performClick()
    assertTrue(activity.isFinishing)
  }

  @Test
  fun corruptShowsError() {
    repository.error = LibraryError.Corrupt
    launch()
    compose.onNodeWithText("This prototype could not be opened.").assertIsDisplayed()
  }

  @Test
  fun unsupportedShowsError() {
    repository.error = LibraryError.UnsupportedFormat
    launch()
    compose.onNodeWithText("This prototype needs a newer ProtoViewer.").assertIsDisplayed()
  }

  @Test
  fun relaunchFinishesTaskAndStartsSameLibraryId() {
    val activity = launch()
    compose.onNodeWithText("Relaunch").performClick()
    compose.waitForIdle()
    assertTrue(activity.isFinishing)
    assertEquals(
      FIRST,
      shadowOf(activity).nextStartedActivity.getStringExtra(ViewerLaunch.LIBRARY_ID),
    )
    assertTrue(repository.resets.isEmpty())
  }

  @Test
  fun resetConfirmsClearsAndRelaunches() {
    val activity = launch()
    compose.onNodeWithText("Reset").performClick()
    compose.onNodeWithText("Reset prototype?").assertIsDisplayed()
    compose.onNodeWithTag("confirm-reset").performClick()
    compose.waitForIdle()
    assertEquals(listOf(FIRST), repository.resets)
    assertTrue(activity.isFinishing)
  }

  @Test
  fun provenanceTracksLiveSettingAndRemainsOutsidePrototypeBounds() {
    launch()
    compose.onNodeWithTag("network-provenance").assertDoesNotExist()
    compose.runOnIdle { settings.setAllowNetwork(true) }
    val indicator =
      compose.onNodeWithTag("network-provenance").assertIsDisplayed().getUnclippedBoundsInRoot()
    val content = compose.onNodeWithTag("viewer-content").getUnclippedBoundsInRoot()
    assertTrue(indicator.bottom > indicator.top)
    assertTrue(indicator.bottom <= content.top)
    compose.runOnIdle { settings.setAllowNetwork(false) }
    compose.onNodeWithTag("network-provenance").assertDoesNotExist()
  }

  @Test
  fun reservedActionsRemainOutsidePrototypeBounds() {
    launch()
    val actions = compose.onNodeWithTag("viewer-actions").getUnclippedBoundsInRoot()
    val content = compose.onNodeWithTag("viewer-content").getUnclippedBoundsInRoot()
    assertTrue(actions.bottom > actions.top)
    assertTrue(content.bottom > content.top)
    assertTrue(actions.bottom <= content.top)
  }
}
