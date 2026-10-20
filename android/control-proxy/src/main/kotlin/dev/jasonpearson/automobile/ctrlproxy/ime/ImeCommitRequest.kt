package dev.jasonpearson.automobile.ctrlproxy.ime

import dev.jasonpearson.automobile.protocol.ImeTextDelivery

/** Editor delivery inputs shared by the controller's IME seam and the running keyboard. */
data class ImeCommitRequest(
  val text: String,
  val priorImeId: String?,
  val isCancelled: () -> Boolean = { false },
  val delivery: ImeTextDelivery = ImeTextDelivery.COMMIT,
  val timeoutMs: Long? = null,
  val requestDeadlineMs: Long = Long.MAX_VALUE,
  val trace: Boolean = false,
)
