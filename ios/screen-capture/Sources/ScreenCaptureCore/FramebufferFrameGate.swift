import Foundation

/// Pure frame-selection policy for Simulator framebuffer capture (#19015).
///
/// The capture loop polls the main display IOSurface at the requested fps. The
/// surface's seed changes on every frame CoreSimulator draws, so a static screen
/// encodes nothing; a keyframe request (a viewer's PLI or the daemon's liveness
/// probe) re-encodes the unchanged surface so the request is always answered.
/// The surface itself is re-fetched on a slower cadence, because a rotation or
/// display reconfiguration can replace it and each fetch is an XPC round trip.
public struct FramebufferFrameGate: Equatable {
    /// How often the loop asks CoreSimulator for the current surface object.
    public static let defaultSurfaceRefreshInterval: TimeInterval = 1.0

    public let surfaceRefreshInterval: TimeInterval
    private var lastSurfaceID: UInt32?
    private var lastSeed: UInt32?
    private var lastSurfaceFetch: TimeInterval?

    public init(surfaceRefreshInterval: TimeInterval = FramebufferFrameGate.defaultSurfaceRefreshInterval) {
        self.surfaceRefreshInterval = surfaceRefreshInterval
    }

    /// Whether the loop should fetch the surface again before reading its seed.
    public func shouldRefetchSurface(now: TimeInterval) -> Bool {
        guard let lastSurfaceFetch else { return true }
        return now - lastSurfaceFetch >= surfaceRefreshInterval
    }

    public mutating func recordSurfaceFetch(now: TimeInterval) {
        lastSurfaceFetch = now
    }

    /// Whether this tick should encode the surface: a new surface, a new seed, or
    /// a pending keyframe request each produce a frame.
    public func shouldEncode(surfaceID: UInt32, seed: UInt32, keyFrameRequested: Bool) -> Bool {
        keyFrameRequested || surfaceID != lastSurfaceID || seed != lastSeed
    }

    /// Record a frame the encoder accepted. A frame the encoder dropped is not
    /// recorded, so the next tick retries the same seed.
    public mutating func recordEncoded(surfaceID: UInt32, seed: UInt32) {
        lastSurfaceID = surfaceID
        lastSeed = seed
    }
}
