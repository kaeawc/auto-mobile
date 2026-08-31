import Foundation

/// Plan-source loading seam. Refines `Sendable` so the (Sendable) executor can hold it. `Bundle` is
/// not `Sendable`, but it appears only as a method parameter (never stored, never crossing isolation),
/// so it does not constrain the conforming type's sendability.
public protocol AutoMobilePlanLoading: Sendable {
    func loadPlan(at path: String, bundle: Bundle?) throws -> String
}
