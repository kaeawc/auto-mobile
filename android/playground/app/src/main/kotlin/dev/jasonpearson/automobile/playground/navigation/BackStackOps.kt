package dev.jasonpearson.automobile.playground.navigation

import androidx.navigation3.runtime.NavKey

/**
 * Pops to the previous destination, or replaces a lone non-root destination with [home]. Root flows
 * are preserved, and an empty stack is repaired. Returns the resulting top destination. Repeated
 * calls stop at a root, so restarting a flow with two pops never empties the stack.
 */
fun <T : NavKey> MutableList<T>.popOrGoHome(home: T): T {
  when {
    size > 1 -> removeAt(lastIndex)
    firstOrNull() is HomeDestination ||
      firstOrNull() is OnboardingDestination ||
      firstOrNull() is LoginDestination -> Unit
    else -> {
      clear()
      add(home)
    }
  }
  return last()
}
