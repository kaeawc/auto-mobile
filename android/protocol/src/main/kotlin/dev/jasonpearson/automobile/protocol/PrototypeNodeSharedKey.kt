package dev.jasonpearson.automobile.protocol

/** The shared-element key of a node: the `shared` object form, else the v1 `sharedKey` alias. */
val PrototypeNode.resolvedSharedKey: String?
  get() = shared?.key ?: sharedKey
