import Foundation
import os
import XCTestRunner

/// Records the held-session heartbeats and releases an executor performs (#11072), without a daemon.
/// Each `startHeartbeating` counts as one live heartbeat until its handle is stopped.
public final class RecordingHeldSessionController: HeldSessionControlling {
    public enum Event: Equatable, Sendable {
        case heartbeatStarted(String)
        case heartbeatStopped(String)
        case released(String)
    }

    private let state = OSAllocatedUnfairLock<[Event]>(initialState: [])

    public init() {}

    public var events: [Event] { state.withLock { $0 } }

    public var releasedSessions: [String] {
        events.compactMap { event in
            if case let .released(session) = event { return session }
            return nil
        }
    }

    /// Sessions currently being heartbeated (started and not yet stopped).
    public var liveHeartbeats: [String] {
        events.reduce(into: [String]()) { live, event in
            switch event {
            case let .heartbeatStarted(session): live.append(session)
            case let .heartbeatStopped(session):
                if let index = live.firstIndex(of: session) { live.remove(at: index) }
            case .released: break
            }
        }
    }

    public func startHeartbeating(sessionId: String) -> any HeldSessionHeartbeat {
        state.withLock { $0.append(.heartbeatStarted(sessionId)) }
        return Handle(sessionId: sessionId, state: state)
    }

    public func release(sessionId: String) async {
        state.withLock { $0.append(.released(sessionId)) }
    }

    private struct Handle: HeldSessionHeartbeat {
        let sessionId: String
        let state: OSAllocatedUnfairLock<[Event]>

        func stop() {
            state.withLock { $0.append(.heartbeatStopped(sessionId)) }
        }
    }
}
