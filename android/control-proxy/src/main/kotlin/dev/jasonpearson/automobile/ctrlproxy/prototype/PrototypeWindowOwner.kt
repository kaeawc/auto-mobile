package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner

/** One owner per added window: DESTROYED is terminal, including after a failed add. */
internal class PrototypeWindowOwner : LifecycleOwner, SavedStateRegistryOwner, ViewModelStoreOwner {
  private val registry = LifecycleRegistry(this)
  private val savedState = SavedStateRegistryController.create(this)
  override val lifecycle: Lifecycle = registry
  override val savedStateRegistry: SavedStateRegistry = savedState.savedStateRegistry
  override val viewModelStore = ViewModelStore()

  init {
    savedState.performRestore(null)
    registry.currentState = Lifecycle.State.CREATED
  }

  fun resume() {
    registry.currentState = Lifecycle.State.RESUMED
  }

  fun destroy() {
    registry.currentState = Lifecycle.State.DESTROYED
    viewModelStore.clear()
  }
}
