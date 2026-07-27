package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.test.withKeyDown
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSource
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardKey
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import dev.jasonpearson.automobile.desktop.domain.UIElementInfo
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * View-level keyboard routing for issue #3351.
 *
 * Two things are observed for every case, because either alone would pass a broken implementation:
 * **what the view reported to the control callback**, and **what the host still received**. The
 * host is modeled the way a real one works — an ancestor `onKeyEvent`, which Compose invokes only
 * for an event the focused node left unconsumed — so "host shortcuts are not swallowed" is checked
 * rather than assumed.
 *
 * Renders the real view with fakes; no device, daemon or timer.
 */
@OptIn(ExperimentalTestApi::class)
class DeviceScreenViewKeyboardTest {

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

  /** What one run of [hostedView] observed. */
  private class Observed {
    val forwarded = mutableListOf<DeviceKeyStroke>()
    val hostSaw = mutableListOf<Key>()
  }

  /**
   * The device view inside a host that watches for the key events the view leaves unconsumed.
   *
   * [forwardsEverything] decides what the "client" answers: true stands for a keystroke the policy
   * forwarded (consume it), false for one it declined (leave it to the host). Keeping that a plain
   * boolean here rather than running the real policy is deliberate — this test pins the *routing*
   * between the view, the callback's answer and the host; which strokes the policy accepts is
   * pinned by `DeviceKeyboardInputPolicyTest`.
   */
  /**
   * The device view under an ancestor that consumes navigation keys in a **preview** handler,
   * faithful to `ThreePaneShell`'s real one: same `onPreviewKeyEvent` position, same KeyDown gate,
   * same key set (Tab, arrows, Enter, Escape). The real shell's `deviceControlCapturesKeys` is a
   * per-event policy predicate (see `ThreePaneShellDeviceKeyTest`); [standDown] here is its value
   * for the keys this test injects, all of which the policy claims unshifted.
   *
   * This is the composition shape that matters, and the one the isolated tests above cannot see: a
   * preview handler runs BEFORE any focused descendant, so without the stand-down every key the
   * device policy claims is eaten by the shell — including Escape, the only device-button binding.
   */
  @Composable
  private fun shellHostedView(observed: Observed, standDown: Boolean) {
    Box(
      Modifier.focusTarget().onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        if (standDown && !event.isMetaPressed && !event.isCtrlPressed && !event.isAltPressed) {
          return@onPreviewKeyEvent false
        }
        when (event.key) {
          Key.Tab,
          Key.DirectionUp,
          Key.DirectionDown,
          Key.Enter,
          Key.Escape -> {
            observed.hostSaw.add(event.key)
            true
          }
          else -> false
        }
      }
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
        controlMode = DeviceScreenControlMode.Control,
        controlSnapshot = snapshot(),
        onControlTap = { _, _ -> },
        onControlKey = { _, stroke ->
          observed.forwarded.add(stroke)
          true
        },
      )
    }
  }

  @Test
  fun `device keys reach the canvas through the shell's preview navigation handler`() =
    runComposeUiTest {
      // The production regression (#3351): every key below is one the shell's preview handler
      // consumes, and Escape is the client's ONLY device-button binding. Testing the view in
      // isolation cannot see this at all — the handler that eats them is an ancestor.
      val observed = Observed()
      setContent { MaterialTheme { shellHostedView(observed, standDown = true) } }

      listOf(Key.Escape, Key.Enter, Key.DirectionUp, Key.DirectionDown, Key.Tab).forEach { key ->
        onRoot().performKeyInput { pressKey(key) }
      }
      waitForIdle()

      assertEquals(
        listOf(
          DeviceKeyboardKey.Escape,
          DeviceKeyboardKey.Enter,
          DeviceKeyboardKey.ArrowUp,
          DeviceKeyboardKey.ArrowDown,
          DeviceKeyboardKey.Tab,
        ),
        observed.forwarded.map { it.key },
        "every device key must reach the canvas, not the shell",
      )
      assertTrue(
        observed.hostSaw.isEmpty(),
        "the shell must not consume them first (got ${observed.hostSaw})",
      )
    }

  @Test
  fun `the shell keeps its navigation keys when the device canvas is not capturing`() =
    runComposeUiTest {
      // The other direction: standing down must be conditional. If the shell gave up these keys
      // unconditionally, pane navigation would break everywhere else in the app.
      val observed = Observed()
      setContent { MaterialTheme { shellHostedView(observed, standDown = false) } }

      onRoot().performKeyInput { pressKey(Key.Tab) }
      onRoot().performKeyInput { pressKey(Key.Escape) }
      waitForIdle()

      assertEquals(listOf(Key.Tab, Key.Escape), observed.hostSaw, "the shell still navigates")
      assertTrue(
        observed.forwarded.isEmpty(),
        "and nothing reaches the device (got ${observed.forwarded})",
      )
    }

  @Test
  fun `clicking the control canvas restores keyboard focus`() = runComposeUiTest {
    // Focus is requested when control mode is ENTERED. Once anything else takes it — the shell's
    // Tab handler moving panes, a side panel — clicking the mirrored screen must bring it back, or
    // every keystroke silently stays with the host with no visible reason why.
    val observed = Observed()
    val elsewhere = FocusRequester()
    setContent {
      MaterialTheme {
        hostedView(
          observed,
          DeviceScreenControlMode.Control,
          forwardsEverything = true,
          otherFocus = elsewhere,
        )
      }
    }
    runOnIdle { elsewhere.requestFocus() }
    waitForIdle()

    onRoot().performKeyInput { pressKey(Key.Escape) }
    waitForIdle()
    assertTrue(observed.forwarded.isEmpty(), "precondition: focus is elsewhere")

    onRoot().performTouchInput { click() }
    waitForIdle()
    onRoot().performKeyInput { pressKey(Key.Escape) }
    waitForIdle()

    assertEquals(
      listOf(DeviceKeyboardKey.Escape),
      observed.forwarded.map { it.key },
      "a click on the canvas restores focus so keys forward again",
    )
  }

  @Test
  fun `focus changes are reported to the host`() = runComposeUiTest {
    // The signal the shell stands down on. Without it the shell cannot tell whether the device
    // owns the keyboard, and would have to choose between eating device keys and breaking its own
    // navigation.
    val focusStates = mutableListOf<Boolean>()
    val elsewhere = FocusRequester()
    setContent {
      MaterialTheme {
        Box {
          Box(Modifier.focusRequester(elsewhere).focusable())
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
            controlSnapshot = snapshot(),
            onControlTap = { _, _ -> },
            onControlKey = { _, _ -> true },
            onControlFocusChanged = { focusStates.add(it) },
          )
        }
      }
    }
    waitForIdle()
    assertTrue(focusStates.lastOrNull() == true, "entering control mode reports focus gained")

    runOnIdle { elsewhere.requestFocus() }
    waitForIdle()
    assertTrue(focusStates.lastOrNull() == false, "losing focus is reported too")
  }

  @Composable
  private fun hostedView(
    observed: Observed,
    mode: DeviceScreenControlMode,
    forwardsEverything: Boolean,
    otherFocus: FocusRequester? = null,
    snapshot: DeviceFrameSnapshot? = snapshot(),
    selectedElementId: String? = null,
  ) {
    Box(
      Modifier.onKeyEvent { event ->
        // Only key-downs are recorded: the view forwards on KeyDown and deliberately leaves the
        // matching KeyUp unconsumed, so counting both would make every case look half-swallowed.
        if (event.type == KeyEventType.KeyDown) observed.hostSaw.add(event.key)
        false
      }
    ) {
      if (otherFocus != null) {
        Box(Modifier.focusRequester(otherFocus).focusable())
      }
      DeviceScreenView(
        screenshotData = null,
        screenWidth = 1080,
        screenHeight = 2340,
        hierarchy = root,
        selectedElementId = selectedElementId,
        hoveredElementId = null,
        onElementSelected = {},
        onElementHovered = {},
        elementMap = mapOf("root" to root),
        controlMode = mode,
        controlSnapshot = snapshot,
        onControlTap = { _, _ -> },
        onControlKey = { _, stroke ->
          observed.forwarded.add(stroke)
          forwardsEverything
        },
      )
    }
  }

  @Test
  fun `a control-mode keystroke is forwarded and not passed on to the host`() = runComposeUiTest {
    val observed = Observed()
    setContent {
      MaterialTheme {
        hostedView(observed, DeviceScreenControlMode.Control, forwardsEverything = true)
      }
    }

    onRoot().performKeyInput { pressKey(Key.Escape) }
    waitForIdle()

    assertEquals(
      listOf(DeviceKeyboardKey.Escape),
      observed.forwarded.map { it.key },
      "control mode forwards the keystroke exactly once",
    )
    assertTrue(
      Key.Escape !in observed.hostSaw,
      "a forwarded keystroke is consumed, so the host never sees it (got ${observed.hostSaw})",
    )
  }

  @Test
  fun `a keystroke the client declines still reaches the host`() = runComposeUiTest {
    // The host-shortcut guarantee. The view returns the client's own answer as its onKeyEvent
    // result, so an unforwarded chord keeps bubbling to the host's shortcut handling. Consuming
    // unconditionally would silently break every menu accelerator while the device view is focused.
    val observed = Observed()
    setContent {
      MaterialTheme {
        hostedView(observed, DeviceScreenControlMode.Control, forwardsEverything = false)
      }
    }

    onRoot().performKeyInput { withKeyDown(Key.MetaLeft) { pressKey(Key.S) } }
    waitForIdle()

    assertTrue(observed.forwarded.isNotEmpty(), "the view still offers the keystroke to the client")
    assertTrue(
      Key.S in observed.hostSaw,
      "a declined keystroke must reach the host (got ${observed.hostSaw})",
    )
  }

  @Test
  fun `a printable keystroke reaches the client as its character, with no device key`() =
    runComposeUiTest {
      // The typing path end to end through the real view. The policy routes on the character alone
      // here, so a translation that reported a device key for a letter would send it to input/key
      // instead of typing it.
      val observed = Observed()
      setContent {
        MaterialTheme {
          hostedView(observed, DeviceScreenControlMode.Control, forwardsEverything = true)
        }
      }

      onRoot().performKeyInput { withKeyDown(Key.ShiftLeft) { pressKey(Key.A) } }
      waitForIdle()

      // Pressing Shift is itself a key-down the view offers to the client (the real policy ignores
      // a bare modifier); the letter is the last one.
      val stroke = observed.forwarded.last()
      assertEquals(null, stroke.key, "a letter carries no device key")
      assertEquals('A', stroke.character, "shift produces the capital, and shift is not a chord")
      assertTrue(stroke.modifiers.shift)
      assertTrue(!stroke.modifiers.hasChordModifier, "shift alone is not a host chord")
    }

  @Test
  fun `the chord modifiers reach the client so it can apply the host policy`() = runComposeUiTest {
    val observed = Observed()
    setContent {
      MaterialTheme {
        hostedView(observed, DeviceScreenControlMode.Control, forwardsEverything = false)
      }
    }

    onRoot().performKeyInput { withKeyDown(Key.MetaLeft) { pressKey(Key.S) } }
    waitForIdle()

    // Without this the policy could never distinguish Cmd-S from a bare S, and the host-chord rule
    // would be unenforceable no matter how it is written. Assert against the S keystroke
    // SPECIFICALLY — the bare Meta press is also forwarded, and matching it instead would let this
    // pass while S arrived with no modifier at all.
    val stroke =
      assertNotNull(
        observed.forwarded.firstOrNull { it.character == 's' || it.character == 'S' },
        "the S keystroke should reach the client (got ${observed.forwarded})",
      )
    assertTrue(stroke.modifiers.meta, "the held Meta modifier reached the client with S: $stroke")
    assertTrue(stroke.modifiers.hasChordModifier, "and it reads as a chord: $stroke")
  }

  @Test
  fun `inspector mode forwards nothing and leaves every key to the host`() = runComposeUiTest {
    // The IDE plugin never opts into control mode, so keyboard forwarding must not exist there.
    val observed = Observed()
    setContent {
      MaterialTheme {
        // A selection is what gives the inspector view keyboard focus, so this is the state in
        // which it actually receives key events — anything less would pass vacuously.
        hostedView(
          observed,
          DeviceScreenControlMode.Inspector,
          forwardsEverything = true,
          selectedElementId = "root",
        )
      }
    }

    onRoot().performKeyInput { pressKey(Key.A) }
    waitForIdle()

    assertTrue(observed.forwarded.isEmpty(), "inspector mode must forward no keystroke")
    assertTrue(
      Key.A in observed.hostSaw,
      "and the host still receives keys (got ${observed.hostSaw})",
    )
  }

  @Test
  fun `control mode forwards nothing while another node holds focus`() = runComposeUiTest {
    // Mode alone is not the gate — focus is. Keyboard forwarding that ignored focus would type into
    // the device while the user is filling in a field elsewhere in the host.
    val observed = Observed()
    val elsewhere = FocusRequester()
    setContent {
      MaterialTheme {
        hostedView(
          observed,
          DeviceScreenControlMode.Control,
          forwardsEverything = true,
          otherFocus = elsewhere,
        )
      }
    }
    // Entering control mode takes focus, so this must run afterwards to take it away again.
    runOnIdle { elsewhere.requestFocus() }
    waitForIdle()

    onRoot().performKeyInput { pressKey(Key.Escape) }
    waitForIdle()

    assertTrue(
      observed.forwarded.isEmpty(),
      "an unfocused device view must forward nothing (got ${observed.forwarded})",
    )
  }

  @Test
  fun `control mode is inert without a snapshot`() = runComposeUiTest {
    // Fail closed, exactly as the tap and drag paths do: with no snapshot there is no frame the
    // keystroke belongs to, so nothing is forwarded and the host keeps the key.
    val observed = Observed()
    setContent {
      MaterialTheme {
        hostedView(
          observed,
          DeviceScreenControlMode.Control,
          forwardsEverything = true,
          snapshot = null,
        )
      }
    }

    onRoot().performKeyInput { pressKey(Key.Escape) }
    waitForIdle()

    assertTrue(observed.forwarded.isEmpty(), "no snapshot means no forwarding")
    assertTrue(Key.Escape in observed.hostSaw, "and the key is left to the host")
  }

  @Test
  fun `one key press forwards exactly once, not again on release`() = runComposeUiTest {
    // pressKey is a down AND an up. Forwarding both would double every keystroke on the device.
    val observed = Observed()
    setContent {
      MaterialTheme {
        hostedView(observed, DeviceScreenControlMode.Control, forwardsEverything = true)
      }
    }

    onRoot().performKeyInput { pressKey(Key.Escape) }
    waitForIdle()

    assertEquals(1, observed.forwarded.size, "one press is one forwarded keystroke")
  }

  private fun snapshot(sequence: Long = 1L) =
    DeviceFrameSnapshot(
      deviceId = "emulator-5554",
      sequence = sequence,
      capturedAtMs = 1_000L,
      source = DeviceFrameSource.Screenshot,
      frameWidth = 1080,
      frameHeight = 2340,
      deviceWidth = 1080,
      deviceHeight = 2340,
      screenshotData = null,
      hierarchy = null,
      captureSequence = sequence,
      screenshotSequence = sequence,
      hierarchySequence = sequence,
      liveFrameSequence = null,
    )
}
