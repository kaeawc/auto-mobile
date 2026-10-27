package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.PrototypePlatform

/** No permission-needing integrations are registered in the overlay. */
internal fun prototypeRuntimePlatform(): PrototypePlatform = PrototypePlatform.None
