package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightBounds as ModelBounds
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightLineCap as ModelLineCap
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightLineJoin as ModelLineJoin
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightPoint as ModelPoint
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape as ModelShape
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightStyle as ModelStyle
import dev.jasonpearson.automobile.ctrlproxy.models.SmoothingAlgorithm as ModelSmoothing
import dev.jasonpearson.automobile.protocol.HighlightBounds as ProtocolBounds
import dev.jasonpearson.automobile.protocol.HighlightLineCap as ProtocolLineCap
import dev.jasonpearson.automobile.protocol.HighlightLineJoin as ProtocolLineJoin
import dev.jasonpearson.automobile.protocol.HighlightPoint as ProtocolPoint
import dev.jasonpearson.automobile.protocol.HighlightShape as ProtocolShape
import dev.jasonpearson.automobile.protocol.HighlightStyle as ProtocolStyle
import dev.jasonpearson.automobile.protocol.SmoothingAlgorithm as ProtocolSmoothing

/**
 * Converts the pure-Kotlin protocol highlight model (the WebSocket wire type) into the
 * Android-coupled ctrlproxy render model consumed by [OverlayDrawer].
 *
 * The two hierarchies are structurally identical; they exist separately only because the protocol
 * module must stay Android-free while the render model exposes Android helpers such as
 * [ModelBounds.toRectF]. Enum members are mapped by name (the constant names match one-to-one).
 */
internal fun ProtocolShape.toModel(): ModelShape =
    ModelShape(
        type = type,
        bounds = bounds?.toModel(),
        points = points?.map { it.toModel() },
        style = style?.toModel(),
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

private fun ProtocolPoint.toModel(): ModelPoint = ModelPoint(x = x, y = y)

private fun ProtocolStyle.toModel(): ModelStyle =
    ModelStyle(
        strokeColor = strokeColor,
        strokeWidth = strokeWidth,
        dashPattern = dashPattern,
        smoothing = smoothing?.toModel(),
        tension = tension,
        capStyle = capStyle?.toModel(),
        joinStyle = joinStyle?.toModel(),
    )

private fun ProtocolSmoothing.toModel(): ModelSmoothing = ModelSmoothing.valueOf(name)

private fun ProtocolLineCap.toModel(): ModelLineCap = ModelLineCap.valueOf(name)

private fun ProtocolLineJoin.toModel(): ModelLineJoin = ModelLineJoin.valueOf(name)
