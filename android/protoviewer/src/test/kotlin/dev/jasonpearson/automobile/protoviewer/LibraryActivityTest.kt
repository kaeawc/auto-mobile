package dev.jasonpearson.automobile.protoviewer

import android.app.ActivityManager
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
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
  private val settings = FakeSettingsStore()
  private val permission = FakeLocalNetworkPermission()
  private val exports = FakeExportFiles()
  private val sharer = CanonicalLibrarySharer(repository, exports, IdGenerator { SECOND })
  private var controller: ActivityController<LibraryActivity>? = null

  @Before
  fun configure() {
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        repository,
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        LibraryClock { 42 },
        settings = settings,
        localNetworkPermission = { _, result -> permission.apply { this.result = result } },
        sharer = sharer,
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
  fun switchStartsOffAndUpdatesSharedSettingWithoutPromptOnLowerApi() {
    launch()
    compose.onNodeWithTag("allow-network").assertIsOff().performClick().assertIsOn()
    assertTrue(settings.allowNetwork.value)
    assertEquals(0, permission.requests)
    compose.onNodeWithTag("allow-network").performClick().assertIsOff()
    assertFalse(settings.allowNetwork.value)
  }

  @Test
  fun denialTurnsSwitchOffAndExplainsNetworkIsDisabled() {
    launch()
    compose.onNodeWithTag("allow-network").performClick()
    // Deliver the injected platform result without requiring a Robolectric API 37 sandbox.
    compose.runOnIdle { permission.result(false) }
    compose
      .onNodeWithText(
        "Local-network permission denied. Network access is off. Enable the switch to request permission again.",
      )
      .assertIsDisplayed()
    compose.onNodeWithTag("allow-network").assertIsOff()
    assertFalse(settings.allowNetwork.value)
    compose.onNodeWithTag("allow-network").performClick()
    compose
      .onNodeWithText(
        "Local-network permission denied. Network access is off. Enable the switch to request permission again.",
      )
      .assertDoesNotExist()
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

  @Test
  fun deleteRequiresConfirmationAndRemovesEntry() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    val activity = launch()
    val task = existingTask(activity, FIRST)
    compose
      .onNodeWithContentDescription("More options for ${Fixtures.entry().label}")
      .performClick()
    compose.onNodeWithText("Delete").performClick()
    compose.onNodeWithText("Delete prototype?").assertIsDisplayed()
    assertTrue(repository.prototypes.containsKey(FIRST))
    compose.onNodeWithTag("confirm-delete").performClick()
    compose.waitForIdle()
    assertFalse(repository.prototypes.containsKey(FIRST))
    assertTrue(shadowOf(task).isFinishedAndRemoved)
  }

  @Test
  fun shareGrantsOnlyReadAccessToScopedCanonicalExportAndCleansOnReturn() {
    repository.prototypes[FIRST] = Fixtures.prototype()
    val activity = launch()
    compose
      .onNodeWithContentDescription("More options for ${Fixtures.entry().label}")
      .performClick()
    compose.onNodeWithText("Share").performClick()
    val chooser = shadowOf(activity).nextStartedActivity
    assertEquals(Intent.ACTION_CHOOSER, chooser.action)
    val send =
      androidx.core.content.IntentCompat.getParcelableExtra(
        chooser,
        Intent.EXTRA_INTENT,
        Intent::class.java,
      )!!
    assertEquals(Intent.ACTION_SEND, send.action)
    assertEquals(PROTOTYPE_BUNDLE_MIME, send.type)
    assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, send.flags)
    val uri =
      androidx.core.content.IntentCompat.getParcelableExtra(
        send,
        Intent.EXTRA_STREAM,
        android.net.Uri::class.java,
      )!!
    assertEquals("${activity.packageName}.exports", uri.authority)
    assertTrue(uri.path!!.startsWith("/prototype_exports/"))
    assertEquals(uri, send.clipData!!.getItemAt(0).uri)
    assertTrue(exports.files.isNotEmpty())
    shadowOf(activity).receiveResult(chooser, android.app.Activity.RESULT_OK, Intent())
    compose.waitForIdle()
    // Cleanup outlives the Activity and executes on the injected immediate I/O dispatcher.
    assertTrue(exports.files.isEmpty())
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
