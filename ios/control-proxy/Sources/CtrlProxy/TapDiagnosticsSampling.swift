import Foundation

/// Value-producing reads keep XCUITest/UIKit out of deterministic host tests. Each read
/// has its own ObjC guard: failure of one sample never suppresses later samples or the tap.
@MainActor
struct TapDiagnosticReads {
    let baseScreenPoint: () throws -> TapDiagnostics.Point?
    let resolvedScreenPoint: () throws -> TapDiagnostics.Point?
    let application: () throws -> TapDiagnostics.Application
    let screen: () throws -> TapDiagnostics.Screen
    let deviceOrientation: () throws -> TapDiagnostics.OrientationReading
    let interfaceOrientation: () throws -> TapDiagnostics.OrientationReading
}

@MainActor
protocol TapDiagnosticsSampling: Sendable {
    func sample(requested: TapDiagnostics.Requested, reads: TapDiagnosticReads) -> TapDiagnostics
}

struct DefaultTapDiagnosticsSampler: TapDiagnosticsSampling {
    func sample(requested: TapDiagnostics.Requested, reads: TapDiagnosticReads) -> TapDiagnostics {
        var errors: [String] = []
        func read<T>(_ name: String, _ operation: () throws -> T) -> T? {
            do {
                return try catchingObjCException(operation)
            } catch {
                errors.append("\(name): \(error.localizedDescription)")
                return nil
            }
        }
        let application = read("application.frame", reads.application)
        let screen = read("screen", reads.screen)
        let device = read("orientation.device", reads.deviceOrientation)
        let interface = read("orientation.interface", reads.interfaceOrientation)
        // Resolve both points last, immediately before returning to the gesture/log call.
        let base = read("baseScreenPoint", reads.baseScreenPoint).flatMap { $0 }
        let resolved = read("resolvedScreenPoint", reads.resolvedScreenPoint).flatMap { $0 }
        return TapDiagnostics(
            requested: requested, baseScreenPoint: base, resolvedScreenPoint: resolved,
            application: application, screen: screen,
            orientation: device == nil && interface == nil ? nil : .init(device: device, interface: interface),
            sampleErrors: errors
        )
    }
}
