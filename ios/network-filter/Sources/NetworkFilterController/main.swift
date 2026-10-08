import Foundation
import NetworkExtension
import NetworkFilterCore
import SystemExtensions

private final class Controller: NSObject, OSSystemExtensionRequestDelegate {
    private var connection: NSXPCConnection?
    private var request: OSSystemExtensionRequest?
    private let outputLock = NSLock()
    private var finished = false
    private let retries = ProbeStartupRetryCoordinator(scheduler: DispatchProbeRetryScheduler())
    private let stateLock = NSLock()
    private var connectionGeneration: UInt64 = 0
    /// Simulators the host manages; only these can be attributed. `activate`
    /// reads back with none, so every flow is reported unattributed.
    private var managedSimulators: [ManagedSimulator] = []
    /// `apply`, `reset` or `renew`; `nil` for the read-only commands.
    private var ruleCommand: NetworkRuleCommand?

    func run() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 8) { [self] in
            finish(
                .unavailable,
                "Operation timed out; installation may have completed. Run status to reconcile.",
                code: 1
            )
        }
        switch CommandLine.arguments.dropFirst().first {
        case "activate":
            guard ProbeSigning.peerRequirement(identifier: ProbeSigning.providerIdentifier) != nil else {
                finish(
                    .installationRequired,
                    "Run the provisioned, Developer ID signed app from /Applications.",
                    code: 1
                )
                return
            }
            let request = OSSystemExtensionRequest.activationRequest(
                forExtensionWithIdentifier: ProbeSigning.providerIdentifier, queue: .main
            )
            self.request = request
            request.delegate = self
            OSSystemExtensionManager.shared.submitRequest(request)
        case "status", "snapshot":
            do {
                managedSimulators = try ManagedSimulatorArguments.parse(
                    Array(CommandLine.arguments.dropFirst(2)),
                    canonicalize: canonicalDeviceSetPath
                )
            } catch {
                finish(.unavailable, "\(error)", code: 2)
                return
            }
            readSnapshot()
        case let .some(name) where NetworkRuleCommandKind(rawValue: name) != nil:
            do {
                ruleCommand = try NetworkRuleArguments.parse(
                    NetworkRuleCommandKind(rawValue: name) ?? .reset,
                    Array(CommandLine.arguments.dropFirst(2)),
                    canonicalize: canonicalDeviceSetPath
                )
            } catch {
                finish(.unavailable, "\(error)", code: 2)
                return
            }
            readSnapshot()
        default:
            finish(
                .unavailable,
                "Usage: network-filter-controller \(ControllerContract.commands.joined(separator: "|"))"
                    + " [--managed <device-set-path> <udid>]... (status|snapshot)"
                    + " | apply|reset|renew \(NetworkRuleArguments.usage)",
                code: 2
            )
        }
    }

    func requestNeedsUserApproval(_: OSSystemExtensionRequest) {
        finish(
            .approvalRequired,
            "Approve AutoMobile Network Identity Probe in System Settings, then run activate again."
        )
    }

    func request(
        _: OSSystemExtensionRequest,
        actionForReplacingExtension _: OSSystemExtensionProperties,
        withExtension _: OSSystemExtensionProperties
    )
        -> OSSystemExtensionRequest.ReplacementAction
    {
        .replace
    }

    func request(_: OSSystemExtensionRequest, didFailWithError error: Error) {
        finish(.unavailable, error.localizedDescription, code: 1)
    }

    func request(_: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        guard result == .completed else {
            finish(.approvalRequired, "Extension installation will finish after restarting macOS.")
            return
        }
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { [self] error in
            if let error {
                finish(.unavailable, error.localizedDescription, code: 1)
                return
            }
            // Only the containing app's own NEFilterManager configuration is
            // updated. Never enumerate, replace, or disable other filters.
            let configuration = NEFilterProviderConfiguration()
            configuration.filterSockets = true
            configuration.filterPackets = false
            configuration.filterDataProviderBundleIdentifier = ProbeSigning.providerIdentifier
            manager.providerConfiguration = configuration
            manager.localizedDescription = "AutoMobile Network Identity Probe (leased per-app offline)"
            manager.isEnabled = true
            manager.saveToPreferences { [self] error in
                if let error {
                    let nsError = error as NSError
                    let state = nsError.domain == NEFilterErrorDomain &&
                        nsError.code == NEFilterManagerError.configurationPermissionDenied.rawValue
                        ? ControllerState.approvalRequired : .unavailable
                    finish(state, error.localizedDescription, code: 1)
                    return
                }
                // A configuration acknowledgement does not prove the provider
                // has started. Only an authenticated read-back can report ready.
                readSnapshot()
            }
        }
    }

    private func readSnapshot() {
        guard let requirement = ProbeSigning.peerRequirement(identifier: ProbeSigning.providerIdentifier),
              let serviceName = Bundle.main.object(forInfoDictionaryKey: "ProbeMachServiceName") as? String
        else {
            finish(
                .installationRequired,
                "A signed containing app and provider provisioning profiles are required.",
                code: 1
            )
            return
        }
        let generation = beginAttempt()
        let connection = NSXPCConnection(machServiceName: serviceName, options: [])
        self.connection = connection
        connection.setCodeSigningRequirement(requirement)
        connection.remoteObjectInterface = NSXPCInterface(with: ProbeBridge.self)
        connection.resume()
        let proxy = connection.remoteObjectProxyWithErrorHandler { [self] error in
            // The provider is launched lazily, so this fires whenever the
            // read-back beats macOS to resuming the provider's XPC listener.
            guard claimOutcome(generation) else { return }
            retryOrFinish(
                .connection(error as NSError), connection: connection, detail: error.localizedDescription
            )
        }
        guard let service = proxy as? ProbeBridge else {
            guard claimOutcome(generation) else { return }
            connection.invalidate()
            finish(.unavailable, "Provider bridge is unavailable", code: 1)
            return
        }
        if let ruleCommand {
            send(ruleCommand, to: service, generation: generation, connection: connection)
            return
        }
        guard let managed = try? JSONEncoder().encode(managedSimulators) else {
            guard claimOutcome(generation) else { return }
            connection.invalidate()
            finish(.unavailable, "Unable to encode managed simulators", code: 1)
            return
        }
        service.snapshot(version: IdentityProbe.version, managedSimulators: managed) { [self] data, error in
            guard claimOutcome(generation) else { return }
            guard error == nil, let data,
                  let snapshot = try? JSONDecoder().decode(ProbeSnapshot.self, from: data),
                  snapshot.version == IdentityProbe.version, IdentityProbe.modes.contains(snapshot.mode)
            else {
                retryOrFinish(
                    .readback(error),
                    connection: connection,
                    detail: error ?? "Provider returned an incompatible snapshot"
                )
                return
            }
            finish(
                .ready,
                "Provider replied; per-app offline isolation is unverified until the signed run (#10263).",
                snapshot: snapshot
            )
        }
    }

    /// Rule commands are idempotent per revision, so retrying one after a
    /// startup race cannot apply it twice. Only a decoded `NetworkRuleResult`
    /// is definitive; every other ending is `unavailable` with no `rule`, and
    /// the host reconciles with `status`.
    private func send(
        _ command: NetworkRuleCommand,
        to service: ProbeBridge,
        generation: UInt64,
        connection: NSXPCConnection
    ) {
        guard let encoded = try? JSONEncoder().encode(command) else {
            guard claimOutcome(generation) else { return }
            connection.invalidate()
            finish(.unavailable, "Unable to encode the network rule command", code: 1)
            return
        }
        service.rule(version: IdentityProbe.version, command: encoded) { [self] data, error in
            guard claimOutcome(generation) else { return }
            guard error == nil, let data, let result = try? JSONDecoder().decode(NetworkRuleResult.self, from: data)
            else {
                retryOrFinish(
                    .readback(error),
                    connection: connection,
                    detail: error ?? "Provider returned an incompatible rule result"
                )
                return
            }
            finish(.ready, "Provider answered \(command.kind.rawValue): \(result.outcome.rawValue).", rule: result)
        }
    }

    private func retryOrFinish(_ failure: ProbeStartupFailure, connection: NSXPCConnection, detail: String) {
        connection.invalidate()
        guard retries.scheduleRetry(after: failure, { [self] in readSnapshot() }) else {
            finish(.unavailable, detail, code: 1)
            return
        }
    }

    private func beginAttempt() -> UInt64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        connectionGeneration &+= 1
        return connectionGeneration
    }

    /// One connection yields at most one outcome. Both the error handler and the
    /// reply can fire for the same attempt — notably after a retry invalidates
    /// it — and a superseded callback must not spend another retry.
    private func claimOutcome(_ generation: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard generation == connectionGeneration else { return false }
        connectionGeneration &+= 1
        return true
    }

    private func finish(
        _ state: ControllerState,
        _ detail: String,
        code: Int32 = 0,
        snapshot: ProbeSnapshot? = nil,
        rule: NetworkRuleResult? = nil
    ) {
        outputLock.lock()
        defer { outputLock.unlock() }
        guard !finished else { return }
        finished = true
        let result = ControllerResult(state: state, detail: detail, snapshot: snapshot, rule: rule)
        if let data = try? result.encodedLine() {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
        exit(code)
    }
}

/// Executable paths come from the kernel with symlinks resolved (`/tmp` is
/// `/private/tmp`), so device-set paths are compared in the same form. A path
/// that cannot be resolved is kept as given and simply never matches.
private func canonicalDeviceSetPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
}

private let controller = Controller()
controller.run()
RunLoop.main.run()
