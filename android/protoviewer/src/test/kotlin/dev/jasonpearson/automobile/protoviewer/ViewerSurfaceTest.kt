package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
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
import org.robolectric.android.controller.ActivityController

@RunWith(RobolectricTestRunner::class)
class ViewerSurfaceTest {
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
  fun openDialogCannotCoverOrDismissProvenance() {
    install(
      """{"type":"dialog","testTag":"modal","openWhen":{"key":"open","equals":true},"title":"Spec dialog","confirm":{"label":"Close"}}""",
    )
    launch()
    assertReservedBand("modal")
    compose.onNodeWithTag("modal.confirm").performClick()
    compose.onNodeWithText("Spec dialog").assertDoesNotExist()
    assertReservedBand()
  }

  @Test
  fun fullHeightSheetCannotCoverOrDismissProvenance() {
    install(
      """{"type":"bottomSheet","testTag":"modal","openWhen":{"key":"open","equals":true},"detents":["full"],"child":{"type":"button","label":"Close sheet","onTap":[{"type":"setState","key":"open","value":false}]}}""",
    )
    launch()
    assertReservedBand("modal")
    compose.onNodeWithText("Close sheet").performClick()
    compose.onNodeWithText("Close sheet").assertDoesNotExist()
    assertReservedBand()
  }

  @Test
  fun openMenuCannotCoverOrDismissProvenance() {
    install(
      """{"type":"menu","testTag":"modal","openWhen":{"key":"open","equals":true},"items":[{"label":"Close menu"}]}""",
    )
    launch()
    assertReservedBand("modal")
    compose.onNodeWithText("Close menu").performClick()
    compose.onNodeWithText("Close menu").assertDoesNotExist()
    assertReservedBand()
  }

  @Test
  fun selectPopupCannotCoverOrDismissProvenance() {
    install(
      """{"type":"select","testTag":"choice","stateKey":"choice","label":"Choice","options":[{"value":"a","label":"Alpha"},{"value":"b","label":"Beta"}]}""",
    )
    launch()
    compose.onNodeWithTag("choice").performClick()
    assertReservedBand("choice.b")
    compose.onNodeWithText("Beta").assertIsDisplayed().performClick()
    assertReservedBand()
  }

  @Test
  fun floatingPlacementAndOversizedAnchoredOverlayStayBelowProvenance() {
    install(
      """{"type":"box","children":[{"type":"text","text":"Oversized overlay","testTag":"overlay","style":{"width":"fill","height":"fill","background":"#ff0000"},"anchor":{"type":"bounds","bounds":{"x":0,"y":0,"width":4000,"height":4000},"alignment":"cover"}}]}""",
      """{"type":"floating","gravity":"topStart","offset":{"x":0,"y":0}}""",
    )
    launch()
    assertReservedBand("overlay")
  }

  @Test
  fun sheetWindowPlacementStaysBelowProvenance() {
    install(
      """{"type":"text","testTag":"sheet-content","text":"Sheet window"}""",
      """{"type":"sheet","edge":"top","height":4000}""",
    )
    launch()
    assertReservedBand("sheet-content")
  }

  private fun install(root: String, placement: String = """{"type":"fullscreen"}""") {
    val spec =
      """{"id":"surface","motion":"none","window":{"placement":$placement},"state":{"open":true,"choice":"a"},"root":$root}"""
    val validated = PrototypeSpecValidator.validate(spec)
    assertTrue(
      validated.toString(),
      validated is PrototypeSpecValidation.Success,
    )
    val saved =
      SavedPrototypeLoadResult.Loaded(
        FIRST,
        "Surface",
        "surface",
        10,
        (validated as PrototypeSpecValidation.Success).spec,
        spec,
        emptyMap(),
      )
    repository.prototypes[FIRST] = LibraryPrototype(Fixtures.entry(), saved)
    settings.setAllowNetwork(true)
  }

  private fun assertReservedBand(surface: String? = null) {
    val band =
      compose.onNodeWithTag("network-provenance").assertIsDisplayed().getUnclippedBoundsInRoot()
    val content = compose.onNodeWithTag("viewer-content").getUnclippedBoundsInRoot()
    assertTrue(band.bottom <= content.top)
    surface?.let {
      val bounds = compose.onNodeWithTag(it).assertIsDisplayed().fetchSemanticsNode().boundsInWindow
      val bandBounds =
        compose.onNodeWithTag("network-provenance").fetchSemanticsNode().boundsInWindow
      assertTrue(
        "Surface $it overlaps provenance: $bounds / $bandBounds",
        bounds.top >= bandBounds.bottom,
      )
    }
    // A tap on the band cannot reach a spec scrim or consume/dismiss the app-owned band.
    compose.onNodeWithTag("network-provenance").performTouchInput { click() }
    compose.onNodeWithTag("network-provenance").assertIsDisplayed()
    assertTrue(settings.allowNetwork.value)
  }
}
