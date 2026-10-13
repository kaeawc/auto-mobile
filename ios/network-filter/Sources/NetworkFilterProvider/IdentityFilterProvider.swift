import Foundation
import NetworkExtension
import NetworkFilterCore

@objc(IdentityFilterProvider)
final class IdentityFilterProvider: NEFilterDataProvider, NSXPCListenerDelegate {
    private let probe = IdentityProbe(resolver: SecurityProbeIdentityResolver(), processTable: DarwinProcessTable())
    private let clock: SystemMonotonicClock
    private let rules: NetworkRuleStore
    private let shaping: FlowShapingCoordinator
    private let policy: AppFlowPolicy
    private let service: ProbeService
    private var listener: NSXPCListener?

    override init() {
        let clock = SystemMonotonicClock()
        let rules = NetworkRuleStore(clock: clock, supportsShaping: true)
        let shaping = FlowShapingCoordinator(
            shaper: FlowShaper(clock: clock, ruleSource: rules), clock: clock,
            scheduler: DispatchPauseScheduler(clock: clock)
        )
        self.clock = clock
        self.rules = rules
        self.shaping = shaping
        policy = AppFlowPolicy(
            store: rules, processTable: DarwinProcessTable(), identityResolver: SecurityProbeIdentityResolver()
        )
        service = ProbeService(
            probe: probe, rules: rules,
            onRulesChanged: { shaping.rulesChanged() }, onStop: { shaping.stop() },
            shapingActivity: { shaping.status() }
        )
        super.init()
    }

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        let generation = service.stopOrBeginStartup()
        guard let configuration = Bundle.main.object(forInfoDictionaryKey: "NetworkExtension") as? [String: Any],
              let serviceName = configuration["NEMachServiceName"] as? String,
              ProbeSigning.peerRequirement(identifier: ProbeSigning.controllerIdentifier) != nil
        else {
            completionHandler(NSError(domain: "AutoMobileNetworkProbe", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Signed provider and Mach service configuration are required",
            ]))
            return
        }
        let listener = NSXPCListener(machServiceName: serviceName)
        listener.delegate = self
        self.listener = listener
        listener.resume()
        // New flows select offline or data filtering; established flows are not
        // revisited when a rule is installed.
        apply(NEFilterSettings(rules: [], defaultAction: .filterData)) { [weak self] error in
            guard self?.service.finishStartup(generation: generation, succeeded: error == nil) == true else {
                listener.invalidate()
                completionHandler(NSError(domain: "AutoMobileNetworkProbe", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Provider stopped or restarted during startup",
                ]))
                return
            }
            if error != nil {
                listener.invalidate()
            }
            completionHandler(error)
        }
    }

    override func stopFilter(with _: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        service.stopOrBeginStartup()
        listener?.invalidate()
        listener = nil
        completionHandler()
    }

    // MARK: - Data path: UNVERIFIED NetworkExtension assumptions

    // 1. A paused flow receives no data callbacks in either direction until
    // resumed; otherwise the scheduler passes one debt grant, then drops it.
    // 2. Partial passBytes is honoured; the next callback offers remaining bytes
    // up to peekBytes. Datagram flows accept a whole datagram byte count.
    // 3. resumeFlow accepts pass/peek for data pauses and filter-data/allow/drop
    // for new-flow pauses. Resume is attempted at least 10 ms after pause return.
    // 4. UDP flows survive pauses up to 8 s (Apple documents 10 s).
    // 5. Wall-deadline wake-ups fire promptly after sleep; the 1 s tick backs up.
    // 6. NEFilterFlow.identifier is lifetime-stable and unique among live flows.
    // 7. Streams complete both directions; otherwise 60 s idle eviction frees
    // the slot.
    // 8. allow() from one direction's data-complete callback does not stop
    // filtering the other direction; if false, the other direction is unshaped.
    // 9. allow() from data on a paused flow does not resume or unfilter it before
    // resumeFlow; if false, the rest of the flow is unshaped. In either case the
    // pending pause is still settled once. Traffic effects remain unverified
    // until the signed run (#10263).

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        probe.record(
            sourceAppAuditToken: flow.sourceAppAuditToken,
            sourceProcessAuditToken: flow.sourceProcessAuditToken
        )
        // Allows without any lookup unless a leased rule is active; a
        // flow it cannot attribute to the rule's simulator and app is allowed.
        switch policy.verdict(
            sourceAppAuditToken: flow.sourceAppAuditToken,
            sourceProcessAuditToken: flow.sourceProcessAuditToken
        ) {
        case .allow:
            return .allow()
        case .drop:
            return .drop()
        case let .shape(target):
            guard let socket = flow as? NEFilterSocketFlow else { return .allow() }
            let transport: FlowTransport = socket.socketProtocol == IPPROTO_UDP || socket.socketType == SOCK_DGRAM ?
                .datagram : .stream
            let verdict = shaping
                .newFlow(flow.identifier, target: target, transport: transport) { [weak self] verdict in
                    self?.resumeFlow(flow, with: Self.newFlowResumeVerdict(verdict))
                }
            return Self.newFlowVerdict(verdict)
        }
    }

    override func handleInboundData(
        from flow: NEFilterFlow, readBytesStartOffset _: Int, readBytes: Data
    )
        -> NEFilterDataVerdict
    {
        Self.dataVerdict(shaping.data(
            flow.identifier, direction: .inbound, availableBytes: readBytes.count
        ) { [weak self] verdict in
            self?.resumeFlow(flow, with: Self.dataResumeVerdict(verdict))
        })
    }

    override func handleOutboundData(
        from flow: NEFilterFlow, readBytesStartOffset _: Int, readBytes: Data
    )
        -> NEFilterDataVerdict
    {
        Self.dataVerdict(shaping.data(
            flow.identifier, direction: .outbound, availableBytes: readBytes.count
        ) { [weak self] verdict in
            self?.resumeFlow(flow, with: Self.dataResumeVerdict(verdict))
        })
    }

    override func handleInboundDataComplete(for flow: NEFilterFlow) -> NEFilterDataVerdict {
        shaping.dataComplete(flow.identifier, direction: .inbound)
        return .allow()
    }

    override func handleOutboundDataComplete(for flow: NEFilterFlow) -> NEFilterDataVerdict {
        shaping.dataComplete(flow.identifier, direction: .outbound)
        return .allow()
    }

    private static func newFlowVerdict(_ verdict: ShapedFlowVerdict) -> NEFilterNewFlowVerdict {
        switch verdict {
        case .allow, .pass: .allow()
        case .drop: .drop()
        case .pause: .pause()
        case let .filter(inbound, outbound, peek):
            .filterDataVerdict(
                withFilterInbound: inbound,
                peekInboundBytes: peek,
                filterOutbound: outbound,
                peekOutboundBytes: peek
            )
        }
    }

    private static func newFlowResumeVerdict(_ verdict: FlowResumeVerdict) -> NEFilterNewFlowVerdict {
        switch verdict {
        case .allow, .pass: .allow()
        case .drop: .drop()
        case let .filter(inbound, outbound, peek):
            .filterDataVerdict(
                withFilterInbound: inbound,
                peekInboundBytes: peek,
                filterOutbound: outbound,
                peekOutboundBytes: peek
            )
        }
    }

    private static func dataVerdict(_ verdict: ShapedFlowVerdict) -> NEFilterDataVerdict {
        switch verdict {
        case .allow, .filter: .allow()
        case .drop: .drop()
        case .pause: .pause()
        case let .pass(bytes, peek): NEFilterDataVerdict(passBytes: bytes, peekBytes: peek)
        }
    }

    private static func dataResumeVerdict(_ verdict: FlowResumeVerdict) -> NEFilterDataVerdict {
        switch verdict {
        case .allow, .filter: .allow()
        case .drop: .drop()
        case let .pass(bytes, peek): NEFilterDataVerdict(passBytes: bytes, peekBytes: peek)
        }
    }

    func listener(_: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard let requirement = ProbeSigning.peerRequirement(identifier: ProbeSigning.controllerIdentifier) else {
            return false
        }
        // Foundation validates each message against the designated signed peer,
        // avoiding PID lookup races during XPC authentication (macOS 13+).
        connection.setCodeSigningRequirement(requirement)
        connection.exportedInterface = NSXPCInterface(with: ProbeBridge.self)
        connection.exportedObject = service
        connection.resume()
        return true
    }
}
