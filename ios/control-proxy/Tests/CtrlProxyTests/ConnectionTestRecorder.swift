import Foundation

/// Collects a scripted connection scenario's observable effects. Touched only on the
/// connection's serial queue (the scripted channel's `send` and the connection's
/// callbacks all run there) and read via `queue.sync` after the scenario settles, so
/// it needs no internal lock — `@unchecked Sendable` reflects that queue confinement.
final class ConnectionRecorder: @unchecked Sendable {
    var sends: [Data] = []
    var messages: [Data] = []
    var upgrades = 0
    var closes = 0
}
