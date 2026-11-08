package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.compositionLocalOf

/**
 * When provided, Back at the root of an embedded prototype with back handling calls this instead of
 * dismissing, so a host that only backgrounds its task keeps the renderer and its transient state
 * alive. Nested stacks still pop first.
 */
@InternalAutoMobilePrototypeApi
val LocalPrototypeRootBack = compositionLocalOf<(() -> Unit)?> { null }
