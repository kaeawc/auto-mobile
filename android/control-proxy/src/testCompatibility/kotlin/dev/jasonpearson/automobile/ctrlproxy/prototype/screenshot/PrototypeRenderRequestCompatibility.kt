package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRenderModel
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRequest
import dev.jasonpearson.automobile.ctrlproxy.prototype.request as hostRequest

/** Keeps the original member-call spelling in the unchanged screenshot fixtures. */
internal fun PrototypeRenderModel.request(): PrototypeRequest = hostRequest()
