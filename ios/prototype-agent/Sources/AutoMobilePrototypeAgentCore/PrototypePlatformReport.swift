import Foundation

/// The platform runtime's module report (#14291), separate from authored `/platform` state.
struct PrototypePlatformReport: Codable, Equatable, Sendable {
    enum Runtime: String, Codable, Sendable {
        case ctrlproxy, iosAgent, iosViewer, disposableApp, protoviewer, embedded
    }

    enum Availability: String, Codable, Sendable {
        case ready, degraded, unavailable
    }

    enum Mode: String, Codable, Sendable {
        case real, fake, simulated
    }

    enum Reason: String, CaseIterable, Codable, Sendable {
        case permissionDenied = "permission_denied"
        case hardwareUnavailable = "hardware_unavailable"
        case playServicesMissing = "play_services_missing"
        case simulator
        case fakeMode = "fake_mode"
    }

    struct Module: Codable, Equatable, Sendable {
        let availability: Availability
        let mode: Mode?
        let reason: Reason?
        let inFlight: UInt?

        var wireObject: JSONValue {
            var fields: [String: JSONValue] = ["availability": .string(availability.rawValue)]
            if let mode { fields["mode"] = .string(mode.rawValue) }
            if let reason { fields["reason"] = .string(reason.rawValue) }
            if let inFlight { fields["inFlight"] = .number(Double(inFlight)) }
            return .object(fields)
        }
    }

    let runtime: Runtime
    let appState: String?
    let modules: [String: Module]
    let permissions: [String: String]?

    var wireObject: JSONValue {
        var fields: [String: JSONValue] = [
            "runtime": .string(runtime.rawValue),
            "modules": .object(modules.mapValues(\.wireObject)),
        ]
        if let appState { fields["appState"] = .string(appState) }
        if let permissions { fields["permissions"] = .object(permissions.mapValues(JSONValue.string)) }
        return .object(fields)
    }
}

/// Custom modules may omit mode. First-party modules identify the backing implementation here.
@MainActor
protocol PrototypePlatformReportModeSource {
    var platformReportMode: PrototypePlatformReport.Mode? { get }
    var platformReportReason: PrototypePlatformReport.Reason? { get }
}

extension PrototypePlatformReportModeSource {
    var platformReportMode: PrototypePlatformReport.Mode? { .real }
    var platformReportReason: PrototypePlatformReport.Reason? { platformReportMode == .fake ? .fakeMode : nil }
}

extension PrototypeBiometricModule: PrototypePlatformReportModeSource {}
extension PrototypeClipboardModule: PrototypePlatformReportModeSource {}
extension PrototypeConnectivityModule: PrototypePlatformReportModeSource {}
extension PrototypeDeviceStatusModule: PrototypePlatformReportModeSource {}
extension PrototypeLinksModule: PrototypePlatformReportModeSource {}
extension PrototypeLocationModule: PrototypePlatformReportModeSource {}
extension PrototypePermissionsModule: PrototypePlatformReportModeSource {}
extension PrototypeSensorsModule: PrototypePlatformReportModeSource {}
extension PrototypeSettingsModule: PrototypePlatformReportModeSource {}
extension PrototypeSoundModule: PrototypePlatformReportModeSource {}

extension PrototypePlatformRegistry {
    func reportMode(for name: String) -> PrototypePlatformReport.Mode? {
        (modules[name] as? any PrototypePlatformReportModeSource)?.platformReportMode
    }

    func report(
        runtime: PrototypePlatformReport.Runtime, inFlight: [String: UInt], appState: String? = nil
    )
        -> PrototypePlatformReport
    {
        let reports = modules.mapValues { module in
            let source = module as? any PrototypePlatformReportModeSource
            let mode = source?.platformReportMode
            let count = inFlight[module.name, default: 0]
            switch module.availability() {
            case .ready:
                return PrototypePlatformReport.Module(
                    availability: mode == .simulated ? .degraded : .ready,
                    mode: mode, reason: source?.platformReportReason, inFlight: count
                )
            case .needsPermission:
                return PrototypePlatformReport.Module(
                    availability: .unavailable, mode: mode, reason: .permissionDenied, inFlight: count
                )
            case let .unavailable(reason):
                return PrototypePlatformReport.Module(
                    availability: .unavailable, mode: mode,
                    reason: .init(rawValue: reason), inFlight: count
                )
            }
        }
        let permissions = modules["permissions"]?.state.compactMapValues(\.stringValue) ?? [:]
        return .init(
            runtime: runtime, appState: appState, modules: reports, permissions: permissions.isEmpty ? nil : permissions
        )
    }
}
