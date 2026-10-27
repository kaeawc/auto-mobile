package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text

/**
 * Motion checks the contract cannot express (#14208), the twin of TypeScript's
 * `prototypeMotionV2Error`: a zoomable image claims the double tap, so it cannot also run
 * `onDoubleTap`.
 */
internal object PrototypeMotionRules {
  fun motionErrors(context: Context): PrototypeSpecError? {
    val (_, path) =
      context.nodes.firstOrNull { (node) ->
        node.text("type") == "image" && "zoomable" in node && "onDoubleTap" in node
      } ?: return null
    return fail("$path.zoomable", "A zoomable image cannot also have onDoubleTap")
  }
}
