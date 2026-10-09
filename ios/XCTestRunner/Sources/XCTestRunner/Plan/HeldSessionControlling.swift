import Foundation

/// Keeps a daemon session alive, and frees it, while AI recovery holds the device a failed
/// `executePlan` kept (`holdSessionOnFailure`, #10834 / #11072).
///
/// The daemon keeps the failed attempt's session and device only while something heartbeats it;
/// recovery's model think time would otherwise outlast the heartbeat lease and free the device for
/// another runner. Every outcome that does not resume the plan on that session must release it.
public protocol HeldSessionControlling: Sendable {
    /// Start heartbeating `sessionId`; the returned handle stops it.
    func startHeartbeating(sessionId: String) -> any HeldSessionHeartbeat
    /// Release `sessionId` on the daemon. Best-effort: an unreachable daemon lets the session lapse
    /// at its heartbeat timeout because nothing heartbeats it any more.
    func release(sessionId: String) async
}

public protocol HeldSessionHeartbeat: Sendable {
    func stop()
    /// Why the daemon no longer holds the session, once a heartbeat was answered with
    /// `daemon_session_not_found` (#11102): the daemon's `releaseReason` when it named one, else a
    /// generic description. Nil while the session is still held. A lost session is terminal: the
    /// device may belong to another runner, so recovery must not resume the plan on it.
    var lostReason: String? { get }
}

/// Classifies a `daemon/heartbeat` reply. Mirrors the Android junit-runner's
/// `DaemonSessionReleasedException`: the daemon answers a released or unknown session with
/// `code: daemon_session_not_found` (and `releaseReason` when it released the session itself).
enum HeldSessionLoss {
    static let sessionNotFoundCode = "daemon_session_not_found"

    static func lostReason(in response: [String: Any]?, sessionId: String) -> String? {
        guard let response, (response["success"] as? Bool) != true else { return nil }
        let code = response["code"] as? String
        let error = response["error"] as? String
        guard code == sessionNotFoundCode || error?.hasPrefix("Session not found") == true else { return nil }
        let reason = (response["releaseReason"] as? String) ?? error ?? "session not found"
        return "the daemon released session \(sessionId) (\(reason))"
    }
}

/// Heartbeats and releases over the daemon's Unix socket (`daemon/heartbeat`,
/// `daemon/releaseSession`). The blocking socket I/O runs on a utility queue, never on the
/// cooperative pool.
public struct DaemonSocketHeldSessionController: HeldSessionControlling {
    /// Well inside the daemon's heartbeat lease plus grace.
    public static let defaultHeartbeatIntervalSeconds: TimeInterval = 2
    static let requestTimeoutSeconds: TimeInterval = 2

    private static let queue = DispatchQueue(
        label: "com.automobile.xctestrunner.held-session",
        qos: .utility,
        attributes: .concurrent
    )

    private let socketPath: String
    private let heartbeatIntervalSeconds: TimeInterval
    private let sendHeartbeat: @Sendable (String) async -> [String: Any]?

    public init(
        socketPath: String,
        heartbeatIntervalSeconds: TimeInterval = DaemonSocketHeldSessionController.defaultHeartbeatIntervalSeconds
    ) {
        self.socketPath = socketPath
        self.heartbeatIntervalSeconds = heartbeatIntervalSeconds
        sendHeartbeat = { sessionId in
            await Self.send(method: "daemon/heartbeat", sessionId: sessionId, socketPath: socketPath)
        }
    }

    /// Test seam: heartbeats go through `sendHeartbeat` instead of the daemon socket.
    init(
        socketPath: String,
        heartbeatIntervalSeconds: TimeInterval,
        sendHeartbeat: @escaping @Sendable (String) async -> [String: Any]?
    ) {
        self.socketPath = socketPath
        self.heartbeatIntervalSeconds = heartbeatIntervalSeconds
        self.sendHeartbeat = sendHeartbeat
    }

    public func startHeartbeating(sessionId: String) -> any HeldSessionHeartbeat {
        let interval = heartbeatIntervalSeconds
        let sendHeartbeat = sendHeartbeat
        let loss = LossBox()
        let task = Task.detached(priority: .utility) {
            while !Task.isCancelled {
                let response = await sendHeartbeat(sessionId)
                if let reason = HeldSessionLoss.lostReason(in: response, sessionId: sessionId) {
                    // Heartbeating a terminal UUID forever helps nobody; the executor reads the loss.
                    loss.record(reason)
                    return
                }
                do {
                    try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                } catch {
                    // Cancellation is how stop() ends the loop.
                    return
                }
            }
        }
        return TaskHeartbeat(task: task, loss: loss)
    }

    public func release(sessionId: String) async {
        let response = await Self.send(method: "daemon/releaseSession", sessionId: sessionId, socketPath: socketPath)
        if (response?["success"] as? Bool) != true {
            let reason = (response?["error"] as? String) ?? "daemon unreachable"
            print(
                "[AutoMobile] Could not release held session \(sessionId) (\(reason)); it lapses at its heartbeat timeout"
            )
        }
    }

    private static func send(method: String, sessionId: String, socketPath: String) async -> [String: Any]? {
        await withCheckedContinuation { (continuation: CheckedContinuation<SendableResponse, Never>) in
            queue.async {
                let response = DaemonManager.sendDaemonMethod(
                    method,
                    params: ["sessionId": sessionId],
                    socketPath: socketPath,
                    timeoutSeconds: requestTimeoutSeconds
                )
                continuation.resume(returning: SendableResponse(value: response))
            }
        }.value
    }

    /// The decoded JSON line crosses one continuation and is read only by the awaiting caller.
    private struct SendableResponse: @unchecked Sendable {
        let value: [String: Any]?
    }

    private final class LossBox: @unchecked Sendable {
        private let lock = NSLock()
        private var reason: String?

        func record(_ newReason: String) {
            lock.lock()
            defer { lock.unlock() }
            reason = reason ?? newReason
        }

        var value: String? {
            lock.lock()
            defer { lock.unlock() }
            return reason
        }
    }

    private struct TaskHeartbeat: HeldSessionHeartbeat {
        let task: Task<Void, Never>
        let loss: LossBox

        var lostReason: String? { loss.value }

        func stop() {
            task.cancel()
        }
    }
}
