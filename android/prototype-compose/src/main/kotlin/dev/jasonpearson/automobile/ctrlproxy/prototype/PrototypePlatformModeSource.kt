package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformReport

/** A module with an explicit operating mode (for example, a debug fake). */
@InternalAutoMobilePrototypeApi
interface PrototypePlatformModeSource {
  val platformMode: PrototypePlatformReport.Mode
}
