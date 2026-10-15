import Foundation

/// All child frames, including clipped flow overflow. Units are points (dp in Android tests).
struct PrototypeFlowGridFrames {
    let children: [PrototypeRect]
    let width: Double
    let height: Double
}

enum PrototypeGridPlacement {
    struct Cell: Equatable {
        let row: Int
        let column: Int
        let span: Int
    }

    /// Same formula and unbounded-width fallback as Kotlin's prototypeGridColumnCount.
    static func columnCount(columns: PrototypeGridColumns, available: Double?, gap: Double) -> Int {
        switch columns {
        case let .fixed(count): return max(1, count)
        case let .adaptive(minWidth):
            guard let available, available.isFinite, minWidth > 0, minWidth + gap > 0 else { return 1 }
            let count = floor((available + gap) / (minWidth + gap))
            // Kotlin Double.toInt saturates at Int32.max; avoid a trapping Swift conversion.
            if count >= Double(Int32.max) { return Int(Int32.max) }
            return count > 1 ? Int(count) : 1
        }
    }

    /// Kotlin's row-major packing, including the partially occupied row before a wide span.
    static func cells(count: Int, spans: [Int]) -> [Cell] {
        let count = max(1, count)
        var row = 0
        var column = 0
        return spans.map { requested in
            let span = min(max(1, requested), count)
            if span > count - column {
                row += 1
                column = 0
            }
            let cell = Cell(row: row, column: column, span: span)
            column += span
            if column == count {
                row += 1
                column = 0
            }
            return cell
        }
    }

    /// Eager measurement and placement; equal slots, tallest child per row, no scrolling.
    /// With unbounded width, derive slots from natural child widths, as Kotlin does.
    static func frames(
        columns: PrototypeGridColumns,
        available: Double?,
        spacing: Double,
        runSpacing: Double?,
        spans: [Int],
        measure: (_ index: Int, _ width: Double?) -> (width: Double, height: Double)
    )
        -> PrototypeFlowGridFrames
    {
        let available = available.flatMap { $0.isFinite ? max(0, $0) : nil }
        let gap = max(0, spacing)
        let rowGap = max(0, runSpacing ?? spacing)
        let count = columnCount(columns: columns, available: available, gap: gap)
        let cells = Self.cells(count: count, spans: spans)
        var slot = available.map { max(0, ($0 - gap * Double(count - 1)) / Double(count)) } ?? 0
        let sizes = cells.indices.map { index in
            let span = Double(cells[index].span)
            let width = available.map { min($0, slot * span + gap * (span - 1)) }
            return measure(index, width)
        }
        if available == nil {
            slot = cells.indices.map { index in
                let span = Double(cells[index].span)
                return max(0, (sizes[index].width - gap * (span - 1)) / span)
            }.max() ?? 0
        }
        var heights = Array(repeating: 0.0, count: (cells.last?.row).map { $0 + 1 } ?? 0)
        for index in cells.indices {
            heights[cells[index].row] = max(heights[cells[index].row], sizes[index].height)
        }
        var offsets = Array(repeating: 0.0, count: heights.count)
        for row in heights.indices.dropFirst() {
            offsets[row] = offsets[row - 1] + heights[row - 1] + rowGap
        }
        let children = cells.indices.map { index in
            let cell = cells[index]
            let width = slot * Double(cell.span) + gap * Double(cell.span - 1)
            return PrototypeRect(
                x: Double(cell.column) * (slot + gap), y: offsets[cell.row],
                width: available.map { min($0, width) } ?? width, height: sizes[index].height
            )
        }
        return PrototypeFlowGridFrames(
            children: children,
            width: available ?? (slot * Double(count) + gap * Double(count - 1)),
            height: (offsets.last ?? 0) + (heights.last ?? 0)
        )
    }
}

enum PrototypeFlowPlacement {
    /// Oversized first children occupy their own line; an exact fit stays on the current line.
    static func lines(widths: [Double], available: Double?, spacing: Double) -> [Int] {
        let limit = available.flatMap { $0.isFinite ? max(0, $0) : nil } ?? .infinity
        let gap = max(0, spacing)
        var line = 0
        var used = 0.0
        var occupied = false
        return widths.map { width in
            let width = max(0, width)
            if occupied, used + gap + width > limit {
                line += 1
                used = 0
                occupied = false
            }
            used += (occupied ? gap : 0) + width
            occupied = true
            return line
        }
    }

    /// The cap changes only the container height. All overflow frames remain below its clip.
    static func frames(
        sizes: [(width: Double, height: Double)],
        available: Double?, spacing: Double, runSpacing: Double, maxLines: Int?
    )
        -> PrototypeFlowGridFrames
    {
        let lines = Self.lines(widths: sizes.map { $0.width }, available: available, spacing: spacing)
        let gap = max(0, spacing)
        let rowGap = max(0, runSpacing)
        var heights = Array(repeating: 0.0, count: (lines.last).map { $0 + 1 } ?? 0)
        for index in lines.indices {
            heights[lines[index]] = max(heights[lines[index]], sizes[index].height)
        }
        var offsets = Array(repeating: 0.0, count: heights.count)
        for line in heights.indices.dropFirst() {
            offsets[line] = offsets[line - 1] + heights[line - 1] + rowGap
        }
        var cursors = Array(repeating: 0.0, count: heights.count)
        let children = lines.indices.map { index in
            let line = lines[index]
            let frame = PrototypeRect(
                x: cursors[line], y: offsets[line], width: sizes[index].width, height: sizes[index].height
            )
            cursors[line] += sizes[index].width + gap
            return frame
        }
        let visible = min(heights.count, max(1, maxLines ?? heights.count))
        let width = children.map { $0.x + $0.width }.max() ?? 0
        return PrototypeFlowGridFrames(
            children: children, width: width,
            height: visible == 0 ? 0 : offsets[visible - 1] + heights[visible - 1]
        )
    }
}
