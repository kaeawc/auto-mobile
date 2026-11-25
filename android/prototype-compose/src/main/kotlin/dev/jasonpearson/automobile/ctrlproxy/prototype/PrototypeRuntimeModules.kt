package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import kotlinx.coroutines.CoroutineScope

/**
 * A registered module that gives every runtime its own instance (#14257), so one prototype's state
 * never shows in another's `/platform`. The registered value is only a template: the runtime calls
 * [session] once and registers what it returns.
 */
@InternalAutoMobilePrototypeApi
interface PrototypePerRuntimeModule {
  fun session(scope: CoroutineScope): PrototypePlatformModule
}

/**
 * A module that needs the shown spec (#14257), such as one that loads the spec's media players. The
 * runtime calls [configure] when its platform modules start and on every replacement.
 */
@InternalAutoMobilePrototypeApi
interface PrototypeSpecAwareModule {
  fun configure(spec: PrototypeSpec)
}
