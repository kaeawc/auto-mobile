package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
import android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
import android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AccessibilityFlagsControllerTest {
  /** A service whose configuration is absent until bound, counting reads and reconfigurations. */
  private class FakeService(var flags: Int? = null) : AccessibilityFlagsController.Host {
    var reads = 0
    val reconfigurations = mutableListOf<Int>()

    override fun updateServiceFlags(compute: (currentFlags: Int) -> Int?): Boolean {
      val current = flags ?: return false
      reads++
      compute(current)?.let {
        flags = it
        reconfigurations += it
      }
      return true
    }
  }

  private val unrelatedFlag = 0x4000_0000

  @Test
  fun `requested flags are set and cleared while other service flags are kept`() {
    val service = FakeService(flags = unrelatedFlag or FLAG_INCLUDE_NOT_IMPORTANT_VIEWS)
    val controller = AccessibilityFlagsController(service)

    val outcome =
      controller.apply(
        includeNotImportantViews = false,
        reportViewIds = true,
        retrieveInteractiveWindows = true,
        occlusionEnabled = true,
      )

    assertEquals(AccessibilityFlagsController.Outcome.APPLIED, outcome)
    assertEquals(
      listOf(unrelatedFlag or FLAG_REPORT_VIEW_IDS or FLAG_RETRIEVE_INTERACTIVE_WINDOWS),
      service.reconfigurations,
    )
    assertEquals("the configuration is read once per request", 1, service.reads)
  }

  @Test
  fun `re-sending the same flags does not reconfigure the live service`() {
    val service = FakeService(flags = 0)
    val controller = AccessibilityFlagsController(service)
    repeat(3) {
      controller.apply(
        includeNotImportantViews = true,
        reportViewIds = true,
        retrieveInteractiveWindows = false,
        occlusionEnabled = true,
      )
    }

    assertEquals(
      listOf(FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or FLAG_REPORT_VIEW_IDS),
      service.reconfigurations,
    )
    assertEquals(
      AccessibilityFlagsController.Outcome.UNCHANGED,
      controller.apply(
        includeNotImportantViews = true,
        reportViewIds = true,
        retrieveInteractiveWindows = false,
        occlusionEnabled = false,
      ),
    )
  }

  @Test
  fun `occlusion takes effect even before the service is bound`() {
    val service = FakeService(flags = null)
    val controller = AccessibilityFlagsController(service)
    assertTrue("occlusion defaults on", controller.occlusionEnabled)

    val outcome =
      controller.apply(
        includeNotImportantViews = true,
        reportViewIds = true,
        retrieveInteractiveWindows = true,
        occlusionEnabled = false,
      )

    assertEquals(AccessibilityFlagsController.Outcome.UNBOUND, outcome)
    assertFalse(controller.occlusionEnabled)
    assertTrue(service.reconfigurations.isEmpty())
  }

  @Test
  fun `occlusion is updated alongside a flag change`() {
    val service = FakeService(flags = 0)
    val controller = AccessibilityFlagsController(service)

    controller.apply(
      includeNotImportantViews = false,
      reportViewIds = false,
      retrieveInteractiveWindows = true,
      occlusionEnabled = false,
    )
    assertFalse(controller.occlusionEnabled)

    controller.apply(
      includeNotImportantViews = false,
      reportViewIds = false,
      retrieveInteractiveWindows = true,
      occlusionEnabled = true,
    )
    assertTrue(controller.occlusionEnabled)
  }
}
