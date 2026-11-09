package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.prototype.PrototypeStorage

fun interface AppSpecSource {
  fun readSpec(): String?
}

sealed interface AppShellState {
  data object Loading : AppShellState

  data class Ready(val spec: String) : AppShellState

  data object MissingSpec : AppShellState

  data object CorruptSpec : AppShellState
}

/** Storage belongs to the renderer: never pre-restore, clear, or replace the supplied store. */
class AppShellLoader(private val source: AppSpecSource, val storage: PrototypeStorage) {
  fun load(): AppShellState {
    val spec = source.readSpec() ?: return AppShellState.MissingSpec
    return when (PrototypeSpecValidator.validate(spec)) {
      is PrototypeSpecValidation.Success -> AppShellState.Ready(spec)
      is PrototypeSpecValidation.Failure -> AppShellState.CorruptSpec
    }
  }
}

enum class AppShellBackAction {
  MOVE_TASK_TO_BACK,
  POP,
}

/** Nested stacks are popped by AutoMobilePrototype; only a root dismissal reaches the activity. */
fun appShellBackAction(depth: Int): AppShellBackAction {
  require(depth >= 1) { "Prototype stack depth must be positive" }
  return if (depth == 1) AppShellBackAction.MOVE_TASK_TO_BACK else AppShellBackAction.POP
}
