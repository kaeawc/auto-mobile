package dev.jasonpearson.automobile.prototype.appshell

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * Defers a prototype remount until the activity is next resumed.
 *
 * A remount runs the prototype's `onAppear` actions, which may write storage. After an authored
 * dismissal moves the task to the background, remounting straight away would run them while the app
 * is leaving the screen, so the request is held until the user returns.
 */
class ResumedRemountGate(private val remount: () -> Unit) : DefaultLifecycleObserver {
  private var pending = false

  /** Called after the task was moved to the background; the remount waits for the next resume. */
  fun requestAfterBackgrounding() {
    pending = true
  }

  override fun onResume(owner: LifecycleOwner) {
    if (!pending) return
    pending = false
    remount()
  }
}
