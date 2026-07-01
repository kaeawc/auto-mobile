package dev.jasonpearson.automobile.desktop.core.connection

sealed class ConnectionState {
  data class Disconnected(val reason: String? = null) : ConnectionState()

  data object Connecting : ConnectionState()

  data class Connected(val subscribed: Boolean = false) : ConnectionState()

  data class Reconnecting(val attempt: Int, val nextRetryMs: Long) : ConnectionState()

  data class Error(val message: String) : ConnectionState()
}

val ConnectionState.isConnected: Boolean
  get() = this is ConnectionState.Connected

val ConnectionState.shouldReconnect: Boolean
  get() =
    this is ConnectionState.Connecting ||
      this is ConnectionState.Connected ||
      this is ConnectionState.Reconnecting
