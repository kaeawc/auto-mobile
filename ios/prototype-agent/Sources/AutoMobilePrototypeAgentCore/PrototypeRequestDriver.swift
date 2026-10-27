import Foundation

/// Runs the requests a `PrototypeSession` starts (#12529) and reports each answer back to it.
///
/// Inside AutoMobile, a `via: "host"` request is sent as a `prototype_request` frame and ends with
/// the daemon's `prototype_response`. Embedded apps route it to their handler or device client.
/// Client requests run in cancellable tasks; late responses for cancelled calls are ignored.
/// Imported-prototype denial callbacks are bound to their request's consent epoch. Consent is
/// checked again at main-actor delivery so obsolete successes and failures cannot update state.
/// Every completion, including those decided here (no host, no client, a silent host), is
/// delivered asynchronously, never from
/// inside the transition that started the request.
@MainActor
final class PrototypeRequestDriver {
    typealias SendToHost = @MainActor ([String: Any]) -> Bool
    typealias Complete = @MainActor (String, PrototypeRequestResponse) -> Void

    enum HostRoute {
        case daemon(SendToHost)
        case handler(any PrototypeHttpClient)
        /// Reuses the injected device client, including its egress policy.
        case deviceClient
    }

    /// The host enforces `timeoutMs` itself; this is the slack before the device gives up on a
    /// host that never answers.
    static let hostGraceMs = 2000

    private let clock: PrototypeClock
    private var device: (any PrototypeHttpClient)?
    private var hostRoute: HostRoute
    private var hostWatchdogs: [String: PrototypeTimerHandle] = [:]
    private var deviceTasks: [String: Task<Void, Never>] = [:]
    private var notices: [Task<Void, Never>] = []
    /// Delivers a completion to the session; set by its owner.
    var onComplete: Complete?
    /// A host request left the waiting set (answered, timed out, cancelled or failed); the owner of
    /// its connection no longer needs to be remembered.
    var onHostSettled: ((String) -> Void)?
    /// Gets the `prototype_request_cancel` frame for a host request the device no longer wants
    /// (superseded, dismissed, reset or timed out). It goes to the owning connection, if still there;
    /// the host aborts the call and sends no reply.
    var onHostCancel: (([String: Any]) -> Void)?

    init(clock: PrototypeClock, device: (any PrototypeHttpClient)?, hostRoute: HostRoute) {
        self.clock = clock
        self.device = device
        self.hostRoute = hostRoute
    }

    convenience init(clock: PrototypeClock, device: (any PrototypeHttpClient)?, sendToHost: @escaping SendToHost) {
        self.init(clock: clock, device: device, hostRoute: .daemon(sendToHost))
    }

    /// Updates embedded routing without resetting the session or cancelling calls already started.
    func updateClients(device: any PrototypeHttpClient, hostRoute: HostRoute) {
        self.device = device
        self.hostRoute = hostRoute
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
                cancelHost(requestId)
                settleHost(requestId)?.cancel()
                deviceTasks.removeValue(forKey: requestId)?.cancel()
            }
        }
    }

    /// A `prototype_response` frame from the host. A response nobody waits for is dropped.
    func receiveHostResponse(_ frame: [String: Any]) {
        guard let (requestId, response) = PrototypeRequestWire.decodeResponse(frame),
              let watchdog = settleHost(requestId) else { return }
        watchdog.cancel()
        deliver(requestId, response)
    }

    /// The last host connection closed: calls waiting on it will never be answered, so each ends now
    /// instead of at its watchdog.
    func hostDisconnected() {
        hostRequestsLost(hostWatchdogs.keys.sorted())
    }

    /// The connection these host requests went to closed (other connections may remain): each ends
    /// now as `network`. A request that already ended is ignored.
    func hostRequestsLost(_ requestIds: [String]) {
        for requestId in requestIds {
            guard let watchdog = settleHost(requestId) else { continue }
            watchdog.cancel()
            announce(requestId, .failed(
                PrototypeRequestError(.network, "The AutoMobile host disconnected before it answered."),
                durationMs: 0
            ))
        }
    }

    private func cancelHost(_ requestId: String) {
        guard hostWatchdogs[requestId] != nil else { return }
        onHostCancel?(["type": "prototype_request_cancel", "requestId": requestId])
    }

    private func settleHost(_ requestId: String) -> PrototypeTimerHandle? {
        let watchdog = hostWatchdogs.removeValue(forKey: requestId)
        if watchdog != nil { onHostSettled?(requestId) }
        return watchdog
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
        switch hostRoute {
        case let .daemon(sendToHost): startDaemon(job, sendToHost: sendToHost)
        case let .handler(client): startClient(job, client: client)
        case .deviceClient: startDevice(job)
        }
    }

    private func startDaemon(_ job: PrototypeRequestJob, sendToHost: SendToHost) {
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
            guard let self, hostWatchdogs[job.requestId] != nil else { return }
            cancelHost(job.requestId)
            _ = settleHost(job.requestId)
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
        startClient(job, client: device)
    }

    private func startClient(_ job: PrototypeRequestJob, client: any PrototypeHttpClient) {
        let request = PrototypeHttpRequest(job: job)
        let check = PrototypeDeliveryCheck()
        deviceTasks[job.requestId] = Task { [weak self] in
            let response: PrototypeRequestResponse
            do {
                response = try await client.perform(request, delivery: check).requestResponse(for: job.method)
            } catch let failure as PrototypeHttpFailure {
                response = .failed(failure.error, durationMs: failure.durationMs)
            } catch {
                // The protocol promises PrototypeHttpFailure only; anything else is a client bug.
                response = .failed(PrototypeRequestError(.network, "The on-device HTTP client failed."), durationMs: 0)
            }
            self?.finishDevice(job.requestId, response, check: check)
        }
    }

    private func finishDevice(
        _ requestId: String, _ response: PrototypeRequestResponse, check: PrototypeDeliveryCheck
    ) {
        // A cancelled call was removed before its task ended: its answer is not wanted.
        guard deviceTasks.removeValue(forKey: requestId) != nil else { return }
        if let failure = check.obsoleteFailure() {
            deliver(requestId, .failed(failure.error, durationMs: failure.durationMs))
        } else {
            deliver(requestId, response)
        }
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
