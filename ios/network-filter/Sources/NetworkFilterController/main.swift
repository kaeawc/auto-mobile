import Foundation
import NetworkExtension
import NetworkFilterCore
import SystemExtensions

private struct ControllerResult: Encodable {
    let version = IdentityProbe.version
    let state: String
    let detail: String
    var snapshot: ProbeSnapshot?
}

private final class Controller: NSObject, OSSystemExtensionRequestDelegate {
    private var connection: NSXPCConnection?
    private var request: OSSystemExtensionRequest?
    private let outputLock = NSLock()
    private var finished = false

    func run() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 8) { [self] in
            finish(
                "unavailable",
                "Operation timed out; installation may have completed. Run status to reconcile.",
                code: 1
            )
        }
        switch CommandLine.arguments.dropFirst().first {
        case "activate":
            guard ProbeSigning.peerRequirement(identifier: ProbeSigning.providerIdentifier) != nil else {
                finish(
                    "installation_required",
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
            readSnapshot()
        default:
            finish("unavailable", "Usage: network-filter-controller activate|status|snapshot", code: 2)
        }
    }

    func requestNeedsUserApproval(_: OSSystemExtensionRequest) {
        finish(
            "approval_required",
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
        finish("unavailable", error.localizedDescription, code: 1)
    }

    func request(_: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        guard result == .completed else {
            finish("approval_required", "Extension installation will finish after restarting macOS.")
            return
        }
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { [self] error in
            if let error {
                finish("unavailable", error.localizedDescription, code: 1)
                return
            }
            // Only the containing app's own NEFilterManager configuration is
            // updated. Never enumerate, replace, or disable other filters.
            let configuration = NEFilterProviderConfiguration()
            configuration.filterSockets = true
            configuration.filterPackets = false
            configuration.filterDataProviderBundleIdentifier = ProbeSigning.providerIdentifier
            manager.providerConfiguration = configuration
            manager.localizedDescription = "AutoMobile Network Identity Probe (allow only)"
            manager.isEnabled = true
            manager.saveToPreferences { [self] error in
                if let error {
                    let nsError = error as NSError
                    let state = nsError.domain == NEFilterErrorDomain &&
                        nsError.code == NEFilterManagerError.configurationPermissionDenied.rawValue
                        ? "approval_required" : "unavailable"
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
                "installation_required",
                "A signed containing app and provider provisioning profiles are required.",
                code: 1
            )
            return
        }
        let connection = NSXPCConnection(machServiceName: serviceName, options: [])
        self.connection = connection
        connection.setCodeSigningRequirement(requirement)
        connection.remoteObjectInterface = NSXPCInterface(with: ProbeBridge.self)
        connection.resume()
        let proxy = connection.remoteObjectProxyWithErrorHandler { [self] error in
            finish("unavailable", error.localizedDescription, code: 1)
        }
        guard let service = proxy as? ProbeBridge else {
            finish("unavailable", "Provider bridge is unavailable", code: 1)
            return
        }
        service.snapshot(version: IdentityProbe.version) { [self] data, error in
            guard error == nil, let data,
                  let snapshot = try? JSONDecoder().decode(ProbeSnapshot.self, from: data),
                  snapshot.version == IdentityProbe.version, snapshot.mode == "allow_only"
            else {
                finish("unavailable", error ?? "Provider returned an incompatible snapshot", code: 1)
                return
            }
            finish(
                "ready",
                "Allow-only provider replied; traffic isolation and shaping remain unverified.",
                snapshot: snapshot
            )
        }
    }

    private func finish(_ state: String, _ detail: String, code: Int32 = 0, snapshot: ProbeSnapshot? = nil) {
        outputLock.lock()
        defer { outputLock.unlock() }
        guard !finished else { return }
        finished = true
        let result = ControllerResult(state: state, detail: detail, snapshot: snapshot)
        if let data = try? JSONEncoder().encode(result) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
        exit(code)
    }
}

private let controller = Controller()
controller.run()
RunLoop.main.run()
