package dev.jasonpearson.automobile.protoviewer

import android.app.ActivityManager
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
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
import org.robolectric.shadows.ShadowAppTask

@RunWith(RobolectricTestRunner::class)
class LibraryActivityTest {
  @get:Rule val compose = createComposeRule()
  private val repository = FakeLibraryRepository()
  private var controller: ActivityController<LibraryActivity>? = null

  @Before
  fun configure() {
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        repository,
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        LibraryClock { 42 },
      )
    }
  }

  @After
  fun close() {
    controller?.pause()?.stop()?.destroy()
  }

  private fun launch(): LibraryActivity {
    controller = Robolectric.buildActivity(LibraryActivity::class.java).setup()
    compose.waitForIdle()
    return checkNotNull(controller).get()
  }

  @Test
  fun emptyLibraryShowsEmptyState() {
    launch()
    compose.onNodeWithText("Your prototype library is empty.").assertIsDisplayed()
  }

  @Test
  fun rowsOpenDocumentIntentWithLibraryId() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    repository.prototypes[SECOND] = Fixtures.prototype(SECOND)
    val activity = launch()
    compose.onNodeWithTag("library-$FIRST").assertIsDisplayed().performClick()
    compose.onNodeWithTag("library-$SECOND").assertIsDisplayed()
    val intent = shadowOf(activity).nextStartedActivity
    assertEquals(ViewerActivity::class.java.name, intent.component?.className)
    assertEquals(FIRST, intent.getStringExtra(ViewerLaunch.LIBRARY_ID))
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_DOCUMENT != 0)
    assertTrue(intent.data.toString().contains(FIRST))
  }

  @Test
  fun resetRequiresConfirmationAndCancellationDoesNothing() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    launch()
    compose
      .onNodeWithContentDescription("More options for ${Fixtures.entry().label}")
      .performClick()
    compose.onNodeWithText("Reset").performClick()
    compose.onNodeWithText("Reset prototype?").assertIsDisplayed()
    compose.onNodeWithText("Cancel").performClick()
    assertTrue(repository.resets.isEmpty())
  }

  @Test
  fun repositoryFailureShowsAnError() {
    repository.error = LibraryError.Storage
    launch()
    compose.onNodeWithText("Unable to read the prototype library.").assertIsDisplayed()
  }

  @Test
  fun tapFocusesExistingDocumentWithoutRestarting() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    val activity = launch()
    val task = existingTask(activity, FIRST)
    compose.onNodeWithTag("library-$FIRST").performClick()
    assertTrue(shadowOf(task).hasMovedToFront())
    assertFalse(shadowOf(task).isFinishedAndRemoved)
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  @Test
  fun relaunchReplacesRestoredDocument() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    val activity = launch()
    val task = existingTask(activity, FIRST)
    compose
      .onNodeWithContentDescription("More options for ${Fixtures.entry().label}")
      .performClick()
    compose.onNodeWithText("Relaunch").performClick()
    assertTrue(shadowOf(task).isFinishedAndRemoved)
    assertEquals(
      FIRST,
      shadowOf(activity).nextStartedActivity.getStringExtra(ViewerLaunch.LIBRARY_ID),
    )
  }

  @Test
  fun confirmedResetClearsStorageAndOpensDocument() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    val activity = launch()
    compose
      .onNodeWithContentDescription("More options for ${Fixtures.entry().label}")
      .performClick()
    compose.onNodeWithText("Reset").performClick()
    compose.onNodeWithTag("confirm-reset").performClick()
    compose.waitForIdle()
    assertEquals(listOf(FIRST), repository.resets)
    assertEquals(
      FIRST,
      shadowOf(activity).nextStartedActivity.getStringExtra(ViewerLaunch.LIBRARY_ID),
    )
  }

  private fun existingTask(activity: LibraryActivity, id: String): ActivityManager.AppTask {
    val task = ShadowAppTask.newInstance()
    shadowOf(task)
      .setTaskInfo(
        ActivityManager.RecentTaskInfo().apply { baseIntent = ViewerLaunch.intent(activity, id) },
      )
    shadowOf(activity.getSystemService(ActivityManager::class.java)).setAppTasks(listOf(task))
    return task
  }
}
