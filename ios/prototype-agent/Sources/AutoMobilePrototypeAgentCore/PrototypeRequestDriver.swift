import Foundation

/// Runs the requests a `PrototypeSession` starts (#12529) and reports each answer back to it.
///
/// A `via: "host"` request is sent to the connected AutoMobile host as a `prototype_request` frame
/// and ends with the host's `prototype_response`; the host has no cancel frame, so a cancelled call
/// is forgotten here and its late response ignored. A `via: "device"` request runs on the injected
/// `PrototypeHttpClient`, and cancelling it cancels the task. Every completion, including the ones
/// decided here (no host, no client, a silent host), is delivered asynchronously, never from
/// inside the transition that started the request.
@MainActor
final class PrototypeRequestDriver {
    typealias SendToHost = @MainActor ([String: Any]) -> Bool
    typealias Complete = @MainActor (String, PrototypeRequestResponse) -> Void

    /// The host enforces `timeoutMs` itself; this is the slack before the device gives up on a
    /// host that never answers.
    static let hostGraceMs = 2000

    private let clock: PrototypeClock
    private let device: (any PrototypeHttpClient)?
    private let sendToHost: SendToHost
    private var hostWatchdogs: [String: PrototypeTimerHandle] = [:]
    private var deviceTasks: [String: Task<Void, Never>] = [:]
    private var notices: [Task<Void, Never>] = []
    /// Delivers a completion to the session; set by its owner.
    var onComplete: Complete?

    init(clock: PrototypeClock, device: (any PrototypeHttpClient)?, sendToHost: @escaping SendToHost) {
        self.clock = clock
        self.device = device
        self.sendToHost = sendToHost
    }

    /// Requests running now (host calls awaiting a response and device tasks).
    var runningCount: Int {
        hostWatchdogs.count + deviceTasks.count
    }

    func perform(_ commands: [PrototypeRequestCommand]) {
        for command in commands {
            switch command {
            case let .start(job):
                switch job.via {
                case .host: startHost(job)
                case .device: startDevice(job)
                }
            case let .cancel(requestId):
                hostWatchdogs.removeValue(forKey: requestId)?.cancel()
                deviceTasks.removeValue(forKey: requestId)?.cancel()
            }
        }
    }

    /// A `prototype_response` frame from the host. A response nobody waits for is dropped.
    func receiveHostResponse(_ frame: [String: Any]) {
        guard let (requestId, response) = PrototypeRequestWire.decodeResponse(frame),
              let watchdog = hostWatchdogs.removeValue(forKey: requestId) else { return }
        watchdog.cancel()
        deliver(requestId, response)
    }

    /// The last host connection closed: calls waiting on it will never be answered, so each ends now
    /// instead of at its watchdog.
    func hostDisconnected() {
        for requestId in hostWatchdogs.keys.sorted() {
            hostWatchdogs.removeValue(forKey: requestId)?.cancel()
            announce(requestId, .failed(
                PrototypeRequestError(.network, "The AutoMobile host disconnected before it answered."),
                durationMs: 0
            ))
        }
    }

    /// Resolves once every request that is running or about to be announced has been delivered;
    /// tests await this instead of sleeping.
    func settled() async {
        while true {
            let pending = Array(deviceTasks.values) + notices
            notices = []
            guard !pending.isEmpty else { return }
            for task in pending {
                await task.value
            }
        }
    }

    // MARK: Host

    private func startHost(_ job: PrototypeRequestJob) {
        guard sendToHost(job.hostFrame) else {
            announce(job.requestId, .failed(
                PrototypeRequestError(
                    .network,
                    "No AutoMobile host is connected to run this request. Connect a host or use via \"device\"."
                ),
                durationMs: 0
            ))
            return
        }
        let waitMs = job.effectiveTimeoutMs + Self.hostGraceMs
        hostWatchdogs[job.requestId] = clock.schedule(afterMilliseconds: waitMs) { [weak self] in
            guard let self, hostWatchdogs.removeValue(forKey: job.requestId) != nil else { return }
            deliver(job.requestId, .failed(
                PrototypeRequestError(.timeout, "The host did not answer within \(waitMs)ms."),
                durationMs: waitMs
            ))
        }
    }

    // MARK: Device

    private func startDevice(_ job: PrototypeRequestJob) {
        guard let device else {
            announce(job.requestId, .failed(
                PrototypeRequestError(.network, "This agent has no on-device HTTP client; use via \"host\"."),
                durationMs: 0
            ))
            return
        }
        let request = PrototypeHttpRequest(job: job)
        deviceTasks[job.requestId] = Task { [weak self] in
            let response: PrototypeRequestResponse
            do {
                response = try await device.perform(request).requestResponse(for: job.method)
            } catch let failure as PrototypeHttpFailure {
                response = .failed(failure.error, durationMs: failure.durationMs)
            } catch {
                // The protocol promises PrototypeHttpFailure only; anything else is a client bug.
                response = .failed(PrototypeRequestError(.network, "The on-device HTTP client failed."), durationMs: 0)
            }
            self?.finishDevice(job.requestId, response)
        }
    }

    private func finishDevice(_ requestId: String, _ response: PrototypeRequestResponse) {
        // A cancelled call was removed before its task ended: its answer is not wanted.
        guard deviceTasks.removeValue(forKey: requestId) != nil else { return }
        deliver(requestId, response)
    }

    // MARK: Delivery

    private func deliver(_ requestId: String, _ response: PrototypeRequestResponse) {
        onComplete?(requestId, response)
    }

    /// Completes a request decided here, after the transition that started it has finished.
    private func announce(_ requestId: String, _ response: PrototypeRequestResponse) {
        notices.append(Task { @MainActor [weak self] in self?.deliver(requestId, response) })
    }
}
