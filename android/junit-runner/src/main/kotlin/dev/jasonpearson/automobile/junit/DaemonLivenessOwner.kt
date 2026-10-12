package dev.jasonpearson.automobile.junit

import java.util.UUID

/** Shared by per-thread sockets and the process-wide HTTP heartbeat loop. */
internal object DaemonLivenessOwner {
  val token: String by lazy { UUID.randomUUID().toString() }
}
