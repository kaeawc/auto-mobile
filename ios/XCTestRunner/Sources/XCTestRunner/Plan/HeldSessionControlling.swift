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

    public init(
        socketPath: String,
        heartbeatIntervalSeconds: TimeInterval = DaemonSocketHeldSessionController.defaultHeartbeatIntervalSeconds
    ) {
        self.socketPath = socketPath
        self.heartbeatIntervalSeconds = heartbeatIntervalSeconds
    }

    public func startHeartbeating(sessionId: String) -> any HeldSessionHeartbeat {
        let socketPath = socketPath
        let interval = heartbeatIntervalSeconds
        let task = Task.detached(priority: .utility) {
            while !Task.isCancelled {
                _ = await Self.send(method: "daemon/heartbeat", sessionId: sessionId, socketPath: socketPath)
                do {
                    try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                } catch {
                    // Cancellation is how stop() ends the loop.
                    return
                }
            }
        }
        return TaskHeartbeat(task: task)
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

    private struct TaskHeartbeat: HeldSessionHeartbeat {
        let task: Task<Void, Never>

        func stop() {
            task.cancel()
        }
    }
}
