package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.click
import androidx.compose.ui.test.down
import androidx.compose.ui.test.moveTo
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.up
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSource
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import dev.jasonpearson.automobile.desktop.domain.UIElementInfo
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * View-level routing coverage for issue #3347: a click in [DeviceScreenControlMode.Control] is
 * reported to `onControlTap` (and never selects an element), while a click in the default
 * [DeviceScreenControlMode.Inspector] still selects an element and reports no control tap. Neither
 * path sends daemon input from the view itself — the control tap is only a reported coordinate.
 * Renders the real view with fakes; no device or daemon.
 */
@OptIn(ExperimentalTestApi::class)
class DeviceScreenViewControlTest {

  private val root =
    UIElementInfo(
      id = "root",
      className = "android.widget.FrameLayout",
      resourceId = null,
      text = null,
      contentDescription = null,
      bounds = ElementBounds(0, 0, 1080, 2340),
      isClickable = false,
      isEnabled = true,
      isFocused = false,
      isSelected = false,
      isScrollable = false,
      isCheckable = false,
      isChecked = false,
      depth = 0,
      children = emptyList(),
    )

  @Test
  fun `control-mode click reports a device tap and does not select`() = runComposeUiTest {
    val controlTaps = mutableListOf<DevicePoint>()
    val selections = mutableListOf<String?>()

    setContent {
      MaterialTheme {
        DeviceScreenView(
          screenshotData = null,
          screenWidth = 1080,
          screenHeight = 2340,
          hierarchy = root,
          selectedElementId = null,
          hoveredElementId = null,
          onElementSelected = { selections.add(it) },
          onElementHovered = {},
          elementMap = mapOf("root" to root),
          controlMode = DeviceScreenControlMode.Control,
          controlSnapshot = snapshot(1080, 2340),
          onControlTap = { _, point -> controlTaps.add(point) },
        )
      }
    }

    onRoot().performTouchInput { click() }
    waitForIdle()

    assertEquals(1, controlTaps.size, "control click should report exactly one tap")
    assertTrue(controlTaps.single().inBounds, "a center click maps inside the device screen")
    // Control mode suppresses selection: the only selection callbacks are the null clears the mode
    // entry emits, never a selected element id.
    assertTrue(
      selections.all { it == null },
      "control mode must not select an element (got $selections)",
    )
  }

  @Test
  fun `inspector-mode click still selects an element and reports no control tap`() =
    runComposeUiTest {
      val controlTaps = mutableListOf<DevicePoint>()
      val selections = mutableListOf<String?>()

      setContent {
        MaterialTheme {
          DeviceScreenView(
            screenshotData = null,
            screenWidth = 1080,
            screenHeight = 2340,
            hierarchy = root,
            selectedElementId = null,
            hoveredElementId = null,
            onElementSelected = { selections.add(it) },
            onElementHovered = {},
            elementMap = mapOf("root" to root),
            // controlMode defaults to Inspector; onControlTap and the snapshot are wired only to
            // prove they stay inert.
            controlSnapshot = snapshot(1080, 2340),
            onControlTap = { _, point -> controlTaps.add(point) },
          )
        }
      }

      onRoot().performTouchInput { click() }
      waitForIdle()

      assertTrue(controlTaps.isEmpty(), "inspector mode must not report a control tap")
      assertNotNull(
        selections.lastOrNull { it != null },
        "inspector click over the root should select it",
      )
      assertEquals("root", selections.last())
    }

  @Test
  fun `a control-mode drag reports one swipe and no tap`() = runComposeUiTest {
    val swipes = mutableListOf<Triple<DeviceFrameSnapshot, DevicePoint, DevicePoint>>()
    val controlTaps = mutableListOf<DevicePoint>()

    setContent {
      MaterialTheme {
        controlView(
          onSwipe = { s, a, b, _ -> swipes.add(Triple(s, a, b)) },
          onTap = { controlTaps.add(it) },
        )
      }
    }

    // Stay well inside the fitted device frame: the viewport is larger than the frame, so a
    // full-height swipe would start and end off the device screen.
    onRoot().performTouchInput { swipe(center + Offset(0f, 80f), center - Offset(0f, 80f)) }
    waitForIdle()

    val (snapshot, start, end) = swipes.single()
    assertEquals(42L, snapshot.sequence, "both ends map through the drag's own snapshot")
    assertTrue(start.inBounds && end.inBounds)
    assertTrue(start.y > end.y, "a swipe up ends above where it started (${start.y} -> ${end.y})")
    // A drag must not ALSO fire the click-to-tap path — that would send two inputs for one gesture.
    assertTrue(controlTaps.isEmpty(), "a drag must not also report a tap (got $controlTaps)")
  }

  @Test
  fun `a movement too small to be a drag still reports a tap and no swipe`() = runComposeUiTest {
    // The threshold must not accidentally suppress click-to-tap, and must not fire both.
    val swipes = mutableListOf<Triple<DeviceFrameSnapshot, DevicePoint, DevicePoint>>()
    val controlTaps = mutableListOf<DevicePoint>()

    setContent {
      MaterialTheme {
        controlView(
          onSwipe = { s, a, b, _ -> swipes.add(Triple(s, a, b)) },
          onTap = { controlTaps.add(it) },
        )
      }
    }

    onRoot().performTouchInput {
      down(center)
      moveTo(center + Offset(2f, 3f))
      up()
    }
    waitForIdle()

    assertTrue(swipes.isEmpty(), "a movement below the drag threshold sends no swipe")
    assertEquals(1, controlTaps.size, "and it still reports exactly one tap")
  }

  /**
   * Drags from below-center to above-center, optionally swapping in a DIFFERENT snapshot halfway
   * through, and returns what the view reported.
   */
  private fun dragReporting(
    swapMidDrag: Boolean
  ): Triple<DeviceFrameSnapshot, DevicePoint, DevicePoint> {
    var reported: Triple<DeviceFrameSnapshot, DevicePoint, DevicePoint>? = null
    runComposeUiTest {
      var current by mutableStateOf(snapshot(1080, 2340, sequence = 42L))
      setContent {
        MaterialTheme {
          DeviceScreenView(
            screenshotData = null,
            screenWidth = 1080,
            screenHeight = 2340,
            hierarchy = root,
            selectedElementId = null,
            hoveredElementId = null,
            onElementSelected = {},
            onElementHovered = {},
            elementMap = mapOf("root" to root),
            controlMode = DeviceScreenControlMode.Control,
            controlSnapshot = current,
            onControlTap = { _, _ -> true },
            onControlSwipe = { s, a, b, _ -> reported = Triple(s, a, b) },
          )
        }
      }

      onRoot().performTouchInput {
        down(center + Offset(0f, 80f))
        moveTo(center)
      }
      waitForIdle()
      if (swapMidDrag) {
        // An equal-aspect resolution change lands while the finger is still down. Re-reading the
        // frame here would rescale the second half of the gesture.
        current = snapshot(540, 1170, sequence = 99L)
        waitForIdle()
      }
      onRoot().performTouchInput {
        moveTo(center - Offset(0f, 80f))
        up()
      }
      waitForIdle()
    }
    return assertNotNull(reported, "the drag should report a swipe")
  }

  @Test
  fun `a snapshot arriving mid-drag cannot change the mapping`() {
    // The whole gesture maps through the frame it STARTED on (issue #3350 on top of #3348's
    // snapshot contract). Both runs make the identical gesture; only the mid-drag swap differs.
    val undisturbed = dragReporting(swapMidDrag = false)
    val swapped = dragReporting(swapMidDrag = true)

    assertEquals(42L, swapped.first.sequence, "the reported snapshot is the one the drag began on")
    assertEquals(undisturbed.second, swapped.second, "start is unaffected by the swap")
    assertEquals(
      undisturbed.third,
      swapped.third,
      "end maps through the ORIGINAL frame, not the one that arrived mid-drag",
    )
  }

  /**
   * Pans the viewport with an INSPECTOR-mode drag made of [moveDeltas] horizontal steps, then flips
   * the same composition to control mode and clicks the viewport centre, returning the device
   * coordinate that click mapped to.
   *
   * The mapped point is the observable: pan lives in the view's private offset state, but every
   * viewport->device mapping runs through that offset, so a click at a fixed viewport point moves
   * in device space by exactly the pan that was applied. An empty [moveDeltas] performs no drag at
   * all and yields the un-panned baseline.
   */
  private fun panThenProbeCentre(moveDeltas: List<Float>): DevicePoint {
    var probed: DevicePoint? = null
    runComposeUiTest {
      var mode by mutableStateOf(DeviceScreenControlMode.Inspector)
      setContent {
        MaterialTheme {
          DeviceScreenView(
            screenshotData = null,
            screenWidth = 1080,
            screenHeight = 2340,
            hierarchy = root,
            selectedElementId = null,
            hoveredElementId = null,
            onElementSelected = {},
            onElementHovered = {},
            elementMap = mapOf("root" to root),
            controlMode = mode,
            controlSnapshot = snapshot(1080, 2340),
            onControlTap = { _, point ->
              probed = point
              true
            },
          )
        }
      }

      if (moveDeltas.isNotEmpty()) {
        onRoot().performTouchInput {
          down(center)
          var travelled = 0f
          moveDeltas.forEach { delta ->
            travelled += delta
            // Distinct event times: two moves stamped at the same instant are coalesced by the
            // pointer pipeline, which would silently make a chunked gesture deliver fewer moves
            // than it looks like it does.
            advanceEventTime(16L)
            moveTo(center + Offset(travelled, 0f))
          }
          up()
        }
        waitForIdle()
      }

      // The pan offset is remembered across the mode flip, so the probe click maps through it.
      mode = DeviceScreenControlMode.Control
      waitForIdle()
      onRoot().performTouchInput { click(center) }
      waitForIdle()
    }
    return assertNotNull(probed, "the probe click should report a control tap")
  }

  @Test
  fun `a pan that crosses touch slop in a single move still moves the viewport`() {
    // The move that crosses slop is reported by awaitTouchSlopOrCancellation, NOT by the drag loop.
    // Dropping it makes a one-move-then-release pan move the viewport by exactly zero.
    val baseline = panThenProbeCentre(emptyList())
    val panned = panThenProbeCentre(listOf(120f))

    assertTrue(
      panned.x != baseline.x,
      "a 120px pan must move the viewport (baseline ${baseline.x}, after pan ${panned.x})",
    )
  }

  @Test
  fun `a pan depends only on total displacement, not on how the moves were chunked`() {
    // The complement of the test above, and what catches a viewport that permanently LAGS the
    // pointer. The same 120px of travel delivered in one, two and three moves must land in the
    // same place. This fails in BOTH directions of the bug: dropping the slop-crossing delta makes
    // the one-move gesture pan by zero, and zeroing the per-step delta (reading positionChange
    // AFTER consuming the change) makes every gesture pan by only its slop-crossing remainder.
    val single = panThenProbeCentre(listOf(120f))
    val two = panThenProbeCentre(listOf(60f, 60f))
    val three = panThenProbeCentre(listOf(40f, 40f, 40f))

    assertTrue(
      kotlin.math.abs(single.x - two.x) <= 1 && kotlin.math.abs(single.x - three.x) <= 1,
      "same travel, same pan (1 move -> ${single.x}, 2 -> ${two.x}, 3 -> ${three.x})",
    )
  }

  @Test
  fun `a fine-grained drag pans by every step, not just the slop crossing`() {
    // A real pointer drag arrives as many small moves. Each step's delta must be read BEFORE the
    // change is consumed — `positionChange()` reports Offset.Zero on a consumed change, so
    // consuming first leaves the viewport stuck at wherever the gesture crossed touch slop.
    val baseline = panThenProbeCentre(emptyList())
    val oneBigMove = panThenProbeCentre(listOf(120f))

    var fineGrained: DevicePoint? = null
    runComposeUiTest {
      var mode by mutableStateOf(DeviceScreenControlMode.Inspector)
      setContent {
        MaterialTheme {
          DeviceScreenView(
            screenshotData = null,
            screenWidth = 1080,
            screenHeight = 2340,
            hierarchy = root,
            selectedElementId = null,
            hoveredElementId = null,
            onElementSelected = {},
            onElementHovered = {},
            elementMap = mapOf("root" to root),
            controlMode = mode,
            controlSnapshot = snapshot(1080, 2340),
            onControlTap = { _, point ->
              fineGrained = point
              true
            },
          )
        }
      }
      // `swipe` injects a dozen ~10px moves, so almost all of the travel arrives through the drag
      // loop rather than through the slop crossing.
      onRoot().performTouchInput { swipe(center, center + Offset(120f, 0f), durationMillis = 200L) }
      waitForIdle()
      mode = DeviceScreenControlMode.Control
      waitForIdle()
      onRoot().performTouchInput { click(center) }
      waitForIdle()
    }

    val panned = assertNotNull(fineGrained)
    assertTrue(panned.x != baseline.x, "a 120px drag must pan the viewport")
    assertTrue(
      kotlin.math.abs(panned.x - oneBigMove.x) <= 1,
      "120px of travel pans the same whether it arrives in one move or twelve " +
        "(twelve -> ${panned.x}, one -> ${oneBigMove.x})",
    )
  }

  /** Clicks [at] in control mode and returns the device coordinate it mapped to. */
  private fun controlTapAt(
    at: (androidx.compose.ui.test.TouchInjectionScope) -> Offset
  ): DevicePoint {
    var tapped: DevicePoint? = null
    runComposeUiTest {
      setContent {
        MaterialTheme { controlView(onSwipe = { _, _, _, _ -> }, onTap = { tapped = it }) }
      }
      onRoot().performTouchInput { click(at(this)) }
      waitForIdle()
    }
    return assertNotNull(tapped, "the click should report a control tap")
  }

  @Test
  fun `the swipe start is the pointer-down position, not where the drag crossed slop`() {
    // The drag threshold is measured from this point in device coordinates, so if the start ever
    // slid to the slop-crossing position the threshold would silently shrink by the slop.
    var start: DevicePoint? = null
    runComposeUiTest {
      setContent {
        MaterialTheme { controlView(onSwipe = { _, a, _, _ -> start = a }, onTap = {}) }
      }
      onRoot().performTouchInput { swipe(center + Offset(0f, 80f), center - Offset(0f, 80f)) }
      waitForIdle()
    }

    assertEquals(
      controlTapAt { it.center + Offset(0f, 80f) },
      assertNotNull(start),
      "the swipe start maps the pointer-down position, unshifted by touch slop",
    )
  }

  @Test
  fun `an inspector-mode drag reports no swipe`() = runComposeUiTest {
    // The IDE plugin never opts into control mode, so drag there must stay viewport pan and
    // produce no daemon input at all.
    val swipes = mutableListOf<Triple<DeviceFrameSnapshot, DevicePoint, DevicePoint>>()

    setContent {
      MaterialTheme {
        controlView(
          mode = DeviceScreenControlMode.Inspector,
          onSwipe = { s, a, b, _ -> swipes.add(Triple(s, a, b)) },
          onTap = {},
        )
      }
    }

    // Stay well inside the fitted device frame: the viewport is larger than the frame, so a
    // full-height swipe would start and end off the device screen.
    onRoot().performTouchInput { swipe(center + Offset(0f, 80f), center - Offset(0f, 80f)) }
    waitForIdle()

    assertTrue(swipes.isEmpty(), "inspector mode must never report a control swipe")
  }

  @Composable
  private fun controlView(
    mode: DeviceScreenControlMode = DeviceScreenControlMode.Control,
    onSwipe: (DeviceFrameSnapshot, DevicePoint, DevicePoint, Int) -> Unit,
    onTap: (DevicePoint) -> Unit,
  ) {
    DeviceScreenView(
      screenshotData = null,
      screenWidth = 1080,
      screenHeight = 2340,
      hierarchy = root,
      selectedElementId = null,
      hoveredElementId = null,
      onElementSelected = {},
      onElementHovered = {},
      elementMap = mapOf("root" to root),
      controlMode = mode,
      controlSnapshot = snapshot(1080, 2340, sequence = 42L),
      onControlTap = { _, point ->
        onTap(point)
        true
      },
      onControlSwipe = onSwipe,
    )
  }

  private fun snapshot(deviceWidth: Int, deviceHeight: Int, sequence: Long = 1L) =
    DeviceFrameSnapshot(
      deviceId = "emulator-5554",
      sequence = sequence,
      capturedAtMs = 1_000L,
      source = DeviceFrameSource.Screenshot,
      frameWidth = deviceWidth,
      frameHeight = deviceHeight,
      deviceWidth = deviceWidth,
      deviceHeight = deviceHeight,
      screenshotData = null,
      hierarchy = null,
      coordinateSpace = null,
      captureSequence = sequence,
      frameContext = "epoch:$sequence",
      screenshotSequence = sequence,
      hierarchySequence = sequence,
      liveFrameSequence = null,
    )

  /**
   * Clicks the center of a control-mode view whose snapshot carries [deviceWidth] x [deviceHeight].
   */
  @OptIn(ExperimentalTestApi::class)
  private fun centerTapWithSnapshotBounds(deviceWidth: Int, deviceHeight: Int): DevicePoint {
    var tap: DevicePoint? = null
    runComposeUiTest {
      setContent {
        MaterialTheme {
          DeviceScreenView(
            screenshotData = null,
            // The view's OWN geometry inputs are fixed at the pre-change 1080x2340 screen in every
            // case, so any difference in the result comes from the snapshot alone.
            screenWidth = 1080,
            screenHeight = 2340,
            hierarchy = root,
            selectedElementId = null,
            hoveredElementId = null,
            onElementSelected = {},
            onElementHovered = {},
            elementMap = mapOf("root" to root),
            controlMode = DeviceScreenControlMode.Control,
            controlSnapshot = snapshot(deviceWidth, deviceHeight),
            onControlTap = { _, point ->
              tap = point
              true
            },
          )
        }
      }
      onRoot().performTouchInput { click() }
      waitForIdle()
    }
    return assertNotNull(tap, "control mode must report a tap")
  }

  @Test
  fun `a control click maps through the snapshot, not the views own hierarchy bounds`() {
    // Issue #3348's equal-aspect resolution change, at the view level. The device dropped from
    // 1080x2340 to 720x1560 — an exact 2:3 scale, so the two share an aspect ratio and no
    // dimension comparison can tell them apart. The view's hierarchy and screenWidth/screenHeight
    // params still describe the OLD screen in both runs; only the snapshot differs. Mapping
    // through the stale bounds would report the same coordinate for both.
    val beforeChange = centerTapWithSnapshotBounds(1080, 2340)
    val afterChange = centerTapWithSnapshotBounds(720, 1560)

    assertTrue(beforeChange.inBounds && afterChange.inBounds)
    // The reported coordinate scales with the SNAPSHOT's device space, 2/3 here (+/-1 for the
    // mapper's nearest-integer rounding). Mapping through the stale bounds would leave them equal.
    assertTrue(
      kotlin.math.abs(afterChange.x - beforeChange.x * 2 / 3) <= 1,
      "x scaled with the snapshot: ${beforeChange.x} -> ${afterChange.x}",
    )
    assertTrue(
      kotlin.math.abs(afterChange.y - beforeChange.y * 2 / 3) <= 1,
      "y scaled with the snapshot: ${beforeChange.y} -> ${afterChange.y}",
    )
  }

  @Test
  fun `control mode is inert without a snapshot`() = runComposeUiTest {
    // Fail closed: with no snapshot there is nothing safe to map through, so no tap is reported.
    val controlTaps = mutableListOf<DevicePoint>()

    setContent {
      MaterialTheme {
        DeviceScreenView(
          screenshotData = null,
          screenWidth = 1080,
          screenHeight = 2340,
          hierarchy = root,
          selectedElementId = null,
          hoveredElementId = null,
          onElementSelected = {},
          onElementHovered = {},
          elementMap = mapOf("root" to root),
          controlMode = DeviceScreenControlMode.Control,
          controlSnapshot = null,
          onControlTap = { _, point -> controlTaps.add(point) },
        )
      }
    }

    onRoot().performTouchInput { click() }
    waitForIdle()

    assertTrue(controlTaps.isEmpty(), "control mode without a snapshot must report no tap")
  }

  @Test
  fun `the reported snapshot is the one the point was mapped through`() = runComposeUiTest {
    // The view reads snapshot+geometry from a single value, so the pair handed to the caller is
    // inherently coherent; the caller dispatches against THAT snapshot's device id.
    val reported = mutableListOf<Pair<DeviceFrameSnapshot, DevicePoint>>()

    setContent {
      MaterialTheme {
        DeviceScreenView(
          screenshotData = null,
          screenWidth = 1080,
          screenHeight = 2340,
          hierarchy = root,
          selectedElementId = null,
          hoveredElementId = null,
          onElementSelected = {},
          onElementHovered = {},
          elementMap = mapOf("root" to root),
          controlMode = DeviceScreenControlMode.Control,
          controlSnapshot = snapshot(720, 1560, sequence = 42L),
          onControlTap = { snapshot, point -> reported.add(snapshot to point) },
        )
      }
    }

    onRoot().performTouchInput { click() }
    waitForIdle()

    val (snapshot, point) = reported.single()
    // The snapshot handed back is the one the point was mapped through — its identity, not a
    // later one that may have arrived by the time the caller dispatches.
    assertEquals(42L, snapshot.sequence)
    assertEquals("emulator-5554", snapshot.deviceId)
    assertTrue(point.inBounds)
  }
}
