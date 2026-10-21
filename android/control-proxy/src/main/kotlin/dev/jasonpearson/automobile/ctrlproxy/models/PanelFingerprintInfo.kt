package dev.jasonpearson.automobile.ctrlproxy.models

import kotlinx.serialization.Serializable

/** Additive wire evidence for host-side physical panel identification. */
@Serializable data class PanelFingerprintInfo(val width: Int, val height: Int)
