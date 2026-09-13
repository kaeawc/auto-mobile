package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightBounds as ModelBounds
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape as ModelShape
import dev.jasonpearson.automobile.protocol.HighlightBounds as ProtocolBounds
import dev.jasonpearson.automobile.protocol.HighlightShape as ProtocolShape

internal fun ProtocolShape.toModel(): ModelShape =
  ModelShape(
    type = type,
    bounds = bounds?.toModel(),
  )

private fun ProtocolBounds.toModel(): ModelBounds =
  ModelBounds(
    x = x,
    y = y,
    width = width,
    height = height,
    sourceWidth = sourceWidth,
    sourceHeight = sourceHeight,
  )
