import SwiftUI

/// Where a node's own content sits inside the frame its size resolved to (a weight share, `fill`, or an
/// authored size). Compose lays text out from the start edge unless `textAlign` says otherwise, so a
/// weighted or `fill` text hugs the leading edge instead of centering (#15436).
/// `boxAlignment` is the already-resolved `style.alignment` of a `box`.
func prototypeContentAlignment(
    nodeType: String,
    arrangement: String?,
    boxAlignment: Alignment,
    textAlign: String?
)
    -> Alignment
{
    switch nodeType {
    case "row":
        switch arrangement {
        case "center": return .center
        case "end": return .trailing
        default: return .leading
        }
    case "column", "flow", "grid":
        switch arrangement {
        case "center": return .leading
        case "end": return .bottomLeading
        default: return .topLeading
        }
    case "box": return boxAlignment
    // Compose's Card lays its content out from the top-start corner, not the centre (#15445).
    case "card": return .topLeading
    case "text":
        switch textAlign {
        case "center": return .center
        case "end": return .trailing
        default: return .leading
        }
    default: return .center
    }
}
