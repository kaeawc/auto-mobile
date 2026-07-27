package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.test.withKeyDown
import dev.jasonpearson.automobile.desktop.core.control.DeviceKeyboardEventTranslator
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The REAL shell's preview key handler standing down for device control (issue #3351).
 *
 * `DeviceScreenViewKeyboardTest` covers the same contract against a stand-in ancestor, which pins
 * the *shape* but cannot catch a regression in `ThreePaneShell` itself. This composes the actual
 * shell and observes its actual navigation callbacks, so removing or loosening the stand-down here
 * fails a test.
 *
 * The observable is the shell's own callbacks: if a key still reaches shell navigation, the
 * corresponding callback fires. Nothing here renders a device.
 */
@OptIn(ExperimentalTestApi::class)
class ThreePaneShellDeviceKeyTest {

  /** Which navigation callbacks the shell invoked for the injected keys. */
  private class ShellActivity {
    val navigated = mutableListOf<String>()
  }

  private fun runShell(
    capturesKeys: Boolean,
    activity: ShellActivity,
    keys: androidx.compose.ui.test.KeyInjectionScope.() -> Unit,
  ) = runShell({ capturesKeys }, activity, vimModeEnabled = false, keys)

  private fun runShell(
    capturesKeys: (androidx.compose.ui.input.key.KeyEvent) -> Boolean,
    activity: ShellActivity,
    vimModeEnabled: Boolean = false,
    keys: androidx.compose.ui.test.KeyInjectionScope.() -> Unit,
  ) {
    runComposeUiTest {
      val centerFocus = FocusRequester()
      setContent {
        MaterialTheme {
          ThreePaneShell(
            showLeftPane = true,
            onToggleLeftPane = { activity.navigated.add("toggleLeft") },
            showRightPane = false,
            onToggleRightPane = { activity.navigated.add("toggleRight") },
            showBottomPane = false,
            onToggleBottomPane = { activity.navigated.add("toggleBottom") },
            deviceName = "emulator-5554",
            foregroundApp = null,
            crashCount = 0,
            anrCount = 0,
            nonFatalCount = 0,
            toolFailureCount = 0,
            currentFps = null,
            currentMemoryMb = null,
            isDaemonConnected = true,
            onNavigateUp = { activity.navigated.add("up") },
            onNavigateDown = { activity.navigated.add("down") },
            onSelectEvent = { activity.navigated.add("select") },
            onDeselectEvent = { activity.navigated.add("deselect") },
            vimModeEnabled = vimModeEnabled,
            deviceControlCapturesKeys = capturesKeys,
            // Something inside the shell must hold focus, or the shell's preview handler is not on
            // the focus path and never runs at all — which would make every assertion below pass
            // vacuously. This stands in for the device canvas.
            centerContent = { Box(Modifier.focusRequester(centerFocus).focusable()) },
            leftPaneContent = {},
            rightPaneContent = {},
            bottomPaneContent = {},
          )
        }
      }
      runOnIdle { centerFocus.requestFocus() }
      waitForIdle()
      onRoot().performKeyInput(keys)
      waitForIdle()
    }
  }

  @Test
  fun `the shell stops claiming device keys while the control canvas holds the keyboard`() {
    // The production regression: these live in a PREVIEW handler, so they are consumed before any
    // focused descendant sees them. Escape is the client's only device-button binding, and Enter
    // and the arrows are the rest of its non-typing vocabulary.
    val capturing = ShellActivity()
    runShell(capturesKeys = true, activity = capturing) {
      pressKey(Key.DirectionUp)
      pressKey(Key.DirectionDown)
      pressKey(Key.Enter)
      pressKey(Key.Escape)
    }

    assertTrue(
      capturing.navigated.isEmpty(),
      "the shell must claim none of them while device control holds the keyboard " +
        "(got ${capturing.navigated})",
    )
  }

  @Test
  fun `the shell still claims those keys when device control is not capturing`() {
    // The other direction, and the one that keeps the stand-down from silently breaking pane
    // navigation for the whole app. Same keys, same shell, only the flag differs.
    val idle = ShellActivity()
    runShell(capturesKeys = false, activity = idle) {
      pressKey(Key.DirectionUp)
      pressKey(Key.DirectionDown)
      pressKey(Key.Enter)
      pressKey(Key.Escape)
    }

    assertEquals(listOf("up", "down", "select", "deselect"), idle.navigated)
  }

  /**
   * The production predicate shape: translate the event and ask the real policy, exactly as
   * `AutoMobileContent` wires `DeviceControlSession.wouldForwardKey`. Using the real policy here is
   * the point — the dead zone this guards is a DISAGREEMENT between the shell's stand-down and the
   * canvas's decision, which a hand-rolled boolean cannot exhibit.
   */
  private fun policyPredicate(): (androidx.compose.ui.input.key.KeyEvent) -> Boolean = { event ->
    DeviceKeyboardInputPolicy.evaluate(stroke = DeviceKeyboardEventTranslator.translate(event)) !is
      DeviceKeyboardDecision.Ignored
  }

  @Test
  fun `the same keystroke stands the shell down where the device can type it`() {
    // The other direction: on Android the policy claims 'j' as typed text, so the shell must NOT
    // navigate — the canvas gets the key.
    val activity = ShellActivity()
    runShell(policyPredicate(), activity, vimModeEnabled = true) {
      pressKey(Key.J)
    }

    assertTrue(
      activity.navigated.isEmpty(),
      "a forwarded printable key must not trigger shell navigation (got ${activity.navigated})",
    )
  }

  @Test
  fun `a shifted arrow the policy declines keeps its shell binding`() {
    // Shift+arrow cannot be transmitted by the daemon (input/key has no modifiers), so the policy
    // declines it — and the shell, asked per event, keeps navigating instead of dead-zoning it.
    // The PLAIN arrow is claimed by the device and must not navigate.
    val activity = ShellActivity()
    runShell(policyPredicate(), activity) {
      withKeyDown(Key.ShiftLeft) { pressKey(Key.DirectionUp) }
      pressKey(Key.DirectionDown)
    }

    assertEquals(
      listOf("up"),
      activity.navigated,
      "shifted arrow stays with the shell; the plain arrow goes to the device",
    )
  }

  @Test
  fun `chorded shell shortcuts survive the stand-down`() {
    // The chord exclusion now lives in the policy the predicate consults — a modifier-bearing
    // chord is a HostChord rejection, so the predicate answers false and the shell keeps its
    // accelerators even while the device canvas owns the rest of the keyboard.
    val capturing = ShellActivity()
    runShell(policyPredicate(), capturing) {
      withKeyDown(Key.MetaLeft) { pressKey(Key.Zero) }
    }

    assertEquals(
      listOf("toggleLeft"),
      capturing.navigated,
      "Cmd-0 is a host chord and must still toggle the pane",
    )
  }
}
