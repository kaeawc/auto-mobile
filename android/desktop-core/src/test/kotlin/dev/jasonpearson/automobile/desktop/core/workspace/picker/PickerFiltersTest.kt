package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PickerFiltersTest {

  private fun dev(
    id: String,
    platform: Platform,
    state: DeviceState,
    osKey: String? = null,
    osLabel: String? = null,
    arch: String? = null,
    formFactor: String? = null,
  ) = PickerDevice(id, "name-$id", platform, state, osKey, osLabel, arch, formFactor = formFactor)

  private val devices =
    listOf(
      dev("a", Platform.Android, DeviceState.Booted, "34", "API 34"),
      dev("b", Platform.Android, DeviceState.Shutdown, "33", "API 33"),
      dev("c", Platform.Ios, DeviceState.Booted, "17", "iOS 17", "arm64"),
      dev("d", Platform.Ios, DeviceState.Shutdown, "16", "iOS 16", "x86_64"),
    )

  @Test
  fun `filteredDevices intersects active dimensions`() {
    assertEquals(
      listOf("a", "b"),
      filteredDevices(devices, PickerFilters(platforms = setOf(Platform.Android))).map { it.id },
    )
    assertEquals(
      listOf("a"),
      filteredDevices(
          devices,
          PickerFilters(platforms = setOf(Platform.Android), states = setOf(DeviceState.Booted)),
        )
        .map { it.id },
    )
  }

  @Test
  fun `state options carry counts under sibling filters`() {
    val all =
      options(devices, PickerFilters(), FilterDimension.State).associate { it.value to it.count }
    assertEquals(2, all["Booted"]) // a, c
    assertEquals(2, all["Shutdown"]) // b, d
    // Once Android is selected, state counts reflect only Android.
    val android =
      options(devices, PickerFilters(platforms = setOf(Platform.Android)), FilterDimension.State)
        .associate { it.value to it.count }
    assertEquals(1, android["Booted"]) // a
    assertEquals(1, android["Shutdown"]) // b
  }

  @Test
  fun `os version options are gated on a platform selection`() {
    assertTrue(options(devices, PickerFilters(), FilterDimension.OsVersion).isEmpty())
    val android =
      options(
        devices,
        PickerFilters(platforms = setOf(Platform.Android)),
        FilterDimension.OsVersion,
      )
    assertEquals(listOf("API 34", "API 33"), android.map { it.label }) // sorted desc
    assertTrue(android.all { it.count == 1 })
  }

  @Test
  fun `architecture options come from devices that carry one`() {
    val arch = options(devices, PickerFilters(), FilterDimension.Architecture)
    assertEquals(listOf("arm64", "x86_64"), arch.map { it.value })
    assertTrue(arch.all { it.count == 1 })
  }

  @Test
  fun `form factor options count known values under sibling filters`() {
    val withFormFactors =
      listOf(
        dev("a", Platform.Android, DeviceState.Booted, formFactor = "phone"),
        dev("b", Platform.Android, DeviceState.Shutdown, formFactor = "tablet"),
        dev("c", Platform.Ios, DeviceState.Booted, formFactor = "phone"),
        dev("d", Platform.Ios, DeviceState.Shutdown),
      )

    assertEquals(
      listOf("phone" to 2, "tablet" to 1),
      options(withFormFactors, PickerFilters(), FilterDimension.FormFactor).map {
        it.value to it.count
      },
    )
    assertEquals(
      listOf("phone" to 1, "tablet" to 1),
      options(
          withFormFactors,
          PickerFilters(platforms = setOf(Platform.Android)),
          FilterDimension.FormFactor,
        )
        .map { it.value to it.count },
    )
    assertEquals(
      listOf("a", "c"),
      filteredDevices(withFormFactors, PickerFilters(formFactors = setOf("phone"))).map { it.id },
    )
  }

  @Test
  fun `query fuzzy-filters option labels`() {
    val android = PickerFilters(platforms = setOf(Platform.Android), query = "34")
    assertEquals(
      listOf("API 34"),
      options(devices, android, FilterDimension.OsVersion).map { it.label },
    )
    val ios = PickerFilters(query = "ios")
    assertEquals(listOf("iOS"), options(devices, ios, FilterDimension.Platform).map { it.label })
  }

  @Test
  fun `selected option is kept even when its count drops to zero`() {
    // Selecting iOS leaves no Android devices, but the Android option stays visible (selected).
    val f = PickerFilters(platforms = setOf(Platform.Ios))
    val platformOpts = options(devices, f, FilterDimension.Platform)
    assertTrue(platformOpts.any { it.value == Platform.Ios.name && it.selected })
  }
}
