package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypeStyle

/** Which axes a pager page expands to fill. */
internal data class PrototypePageFill(val width: Boolean, val height: Boolean)

/**
 * A page fills the pager unless the pager is explicitly `wrap` on that axis (#10086).
 *
 * Pages used to fill unconditionally, so a `wrap` pager reported the window's full height: a
 * floating window then spanned the screen, gravity and offset had nothing to position, and its
 * controls ended up under the status bar. An omitted dimension keeps filling, which is what pagers
 * authored without a size have always rendered; only an explicit `wrap` opts into content size.
 */
internal fun prototypePageFill(style: PrototypeStyle): PrototypePageFill =
  PrototypePageFill(
    width = style.width != PrototypeDimension.Wrap,
    height = style.height != PrototypeDimension.Wrap,
  )
