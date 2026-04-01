import Foundation

/// Processes SDK events before they are buffered for delivery.
/// Return the event (possibly modified) to keep it, or nil to drop it.
public protocol EventProcessing: Sendable {
    func process(_ event: any SdkEvent) -> (any SdkEvent)?
}
