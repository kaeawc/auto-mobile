package dev.jasonpearson.automobile.ctrlproxy.prototype

/** The overlay window request for a mapped spec; embedded apps render the content directly. */
fun PrototypeRenderModel.request() =
  PrototypeRequest(
    placement = placement,
    opacityPercent = opacityPercent,
    hasTextField = hasTextField,
    layer = layer,
    persistent = persistent,
    opaqueSurface = prototypeOpaqueSurface(this),
  ) {
    PrototypeSpecContent(root, theme = theme)
  }
