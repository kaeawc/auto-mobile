import Foundation
import NetworkExtension
import NetworkFilterCore

@objc(IdentityFilterProvider)
final class IdentityFilterProvider: NEFilterDataProvider, NSXPCListenerDelegate {
    private let probe = IdentityProbe(resolver: SecurityProbeIdentityResolver(), processTable: DarwinProcessTable())
    private let rules = NetworkRuleStore(clock: SystemMonotonicClock())
    private lazy var policy = AppFlowPolicy(
        store: rules,
        processTable: DarwinProcessTable(),
        identityResolver: SecurityProbeIdentityResolver()
    )
    private var listener: NSXPCListener?
    private lazy var service = ProbeService(probe: probe, rules: rules)

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
        // No data callbacks: each new flow gets one verdict in handleNewFlow and
        // no socket data is paused or inspected. Established flows are never
        // revisited, so an offline rule leaves open connections running.
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

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        probe.record(
            sourceAppAuditToken: flow.sourceAppAuditToken,
            sourceProcessAuditToken: flow.sourceProcessAuditToken
        )
        // Allows without any lookup unless a leased offline rule is active; a
        // flow it cannot attribute to the rule's simulator and app is allowed.
        switch policy.verdict(
            sourceAppAuditToken: flow.sourceAppAuditToken,
            sourceProcessAuditToken: flow.sourceProcessAuditToken
        ) {
        case .allow:
            return .allow()
        case .drop:
            return .drop()
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
