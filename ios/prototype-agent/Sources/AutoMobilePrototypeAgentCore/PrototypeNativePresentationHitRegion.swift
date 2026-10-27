import Foundation

/// Where the prototype window must accept touches for a native SwiftUI presentation (`.sheet`,
/// `.alert`, `.confirmationDialog`, `.popover`) presented from the overlay window's root (#15463).
/// UIKit puts the presented container in the prototype window, so `PassthroughWindow` has to claim
/// those touches even though no prototype hit rect covers them. Device-free: the agent passes the
/// presented frame and the sheet detent indexes from UIKit.
enum PrototypeNativePresentationHitRegion {
    /// How the presentation treats touches outside its own frame.
    enum Interaction: Equatable, Sendable {
        /// Dimmed and modal: outside taps belong to the presentation (they dismiss it), so the whole
        /// window is claimed.
        case modal
        /// `presentationBackgroundInteraction`: the app stays interactive, so only the presented
        /// frame is claimed and outside touches fall through.
        case backgroundInteractive
    }

    /// A sheet is background-interactive while its selected detent is at or below the largest
    /// undimmed detent (both are indexes into the sheet's detents, smallest first). No undimmed
    /// detent, or an unknown selection, is modal.
    static func interaction(selectedDetentIndex: Int?, largestUndimmedDetentIndex: Int?) -> Interaction {
        guard let selectedDetentIndex, let largestUndimmedDetentIndex,
              selectedDetentIndex <= largestUndimmedDetentIndex else { return .modal }
        return .backgroundInteractive
    }

    /// The window-coordinate rect to claim, or nil when there is nothing to claim (an empty or
    /// off-window presented frame for a background-interactive presentation).
    static func region(interaction: Interaction, presentedFrame: CGRect, windowBounds: CGRect) -> CGRect? {
        switch interaction {
        case .modal:
            return windowBounds.isEmpty ? nil : windowBounds
        case .backgroundInteractive:
            let clipped = presentedFrame.intersection(windowBounds)
            return clipped.isNull || clipped.isEmpty ? nil : clipped
        }
    }
}
