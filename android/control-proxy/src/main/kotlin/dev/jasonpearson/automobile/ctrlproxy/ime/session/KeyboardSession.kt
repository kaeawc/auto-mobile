package dev.jasonpearson.automobile.ctrlproxy.ime.session

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyAction
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardController
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardKey
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardUiState
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.ConfigurableTypingPolicy
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfile
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfiles

interface ImeSwitcher {
  fun switchToPrevious()
}

class KeyboardSession(
  private val controller: KeyboardController,
  private val store: KeyboardProfileStore,
  private val switcher: ImeSwitcher,
) {
  private val tracker = SelectionTracker()
  private var config = EditorConfig(0, 0)
  private var profile = KeyboardProfiles.byId(store.activeProfileId()) ?: KeyboardProfiles.DEFAULT
  private var policy = ConfigurableTypingPolicy(profile.behavior)

  fun onStartInput(
    config: EditorConfig,
    initialSelStart: Int,
    initialSelEnd: Int,
  ): KeyboardUiState {
    this.config = config
    controller.configure(config)
    profile = KeyboardProfiles.byId(store.activeProfileId()) ?: KeyboardProfiles.DEFAULT
    policy = ConfigurableTypingPolicy(profile.behavior)
    tracker.reset(initialSelStart, initialSelEnd)
    return controller.uiState()
  }

  fun onKey(key: KeyboardKey, connection: ImeConnection?): KeyboardUiState {
    val action = controller.press(key)
    if (action == KeyAction.SwitchIme) {
      switcher.switchToPrevious()
    } else if (connection != null) {
      val snapshot = tracker.snapshot(connection)
      val ops =
        when (action) {
          is KeyAction.Text -> policy.onText(action.text, snapshot)
          KeyAction.Backspace -> policy.onBackspace(snapshot)
          KeyAction.Enter -> policy.onEnter(config, snapshot)
          else -> emptyList()
        }
      InputConnectionDriver(connection).execute(ops)
    }
    return controller.uiState()
  }

  fun onUpdateSelection(
    newSelStart: Int,
    newSelEnd: Int,
    candidatesStart: Int,
    candidatesEnd: Int,
    connection: ImeConnection?,
  ) {
    tracker.update(newSelStart, newSelEnd, candidatesStart, candidatesEnd)
    if (connection != null) {
      InputConnectionDriver(connection)
        .execute(policy.onSelectionChanged(tracker.snapshot(connection)))
    }
  }

  fun typeForAutomation(text: String, connection: ImeConnection?): Boolean {
    if (connection == null) return false
    return InputConnectionDriver(connection)
      .execute(policy.onText(text, tracker.snapshot(connection)))
  }

  fun finishComposingForAutomation(connection: ImeConnection?): Boolean {
    if (connection == null) return false
    return InputConnectionDriver(connection).execute(policy.onFinishInput())
  }

  fun onFinishInput(connection: ImeConnection?) {
    val ops = policy.onFinishInput()
    if (connection != null) InputConnectionDriver(connection).execute(ops)
  }

  fun setActiveProfile(id: String): Boolean {
    val selected = KeyboardProfiles.byId(id) ?: return false
    store.setActiveProfileId(selected.id)
    profile = selected
    policy = ConfigurableTypingPolicy(selected.behavior)
    return true
  }

  fun activeProfile(): KeyboardProfile = profile

  fun uiState(): KeyboardUiState = controller.uiState()
}
