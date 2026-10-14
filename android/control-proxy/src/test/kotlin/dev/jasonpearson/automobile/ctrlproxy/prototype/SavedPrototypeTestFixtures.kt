package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeEmitAction
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeWindow

internal fun savedPrototypeFixture(
  id: String = "panel",
  actions: List<PrototypeAction> =
    listOf(PrototypeEmitAction("first"), PrototypeEmitAction("second")),
): SavedPrototypeLoadResult.Loaded =
  SavedPrototypeLoadResult.Loaded(
    id,
    "Panel",
    "fake-panel",
    42L,
    PrototypeSpec(
      id,
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root =
        PrototypeButtonNode(
          testTag = "saved-node",
          label = "Saved button",
          onTap = actions,
        ),
    ),
    "",
    emptyMap(),
  )
