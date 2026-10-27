import Foundation

/// A `bottomSheet` height stop: half or all of the sheet's container, or a fixed size in points.
enum Detent: Decodable, Equatable {
    case half
    case full
    case points(Double)

    private struct Fixed: Decodable {
        let points: Double
        private enum CodingKeys: String, CodingKey { case points = "dp" }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let keyword = try? container.decode(String.self) {
            self = keyword == "full" ? .full : .half
        } else {
            self = try .points(container.decode(Fixed.self).points)
        }
    }

    /// Android's `prototypeSheetHeights`: a fixed detent never exceeds its container.
    func height(in container: Double) -> Double {
        switch self {
        case .half: container / 2
        case .full: container
        case let .points(value): min(value, container)
        }
    }
}
