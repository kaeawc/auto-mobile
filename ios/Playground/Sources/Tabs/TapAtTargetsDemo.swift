import AutoMobileSDK
import SwiftUI

// MARK: - Tap At Targets Demo

/// A screenshot-only tap fixture: all target pixels are drawn into one Canvas,
/// and taps are resolved against the same pure-Swift geometry used by tests.
struct TapAtTargetsDemo: View {
    @Environment(\.autoMobileTheme) private var theme
    @State private var hitTargetIDs = Set<String>()
    @State private var backgroundMisses = 0
    @State private var lastResult: String?
    @State private var flashedTargetID: String?
    @State private var flashToken = UUID()
    @State private var showsCrosshairs = false

    private let targetColors: [Color] = [
        .pgLightPrimary, .pgAccentSkyBlue, .pgAccentGrassGreen, .pgAccentConeOrange,
        .pgAccentSlidePurple, .pgDarkPrimary, .pgDarkSecondary, .pgLightTertiary,
        .pgAccentSandTan, .pgLightSecondary, .pgAccentInk,
    ]

    var body: some View {
        VStack(spacing: 0) {
            targetCanvas
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .layoutPriority(1)

            resultPanel
        }
        .background(theme.background)
        .navigationTitle("Tap At Targets")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "TapAtTargetsDemo")
    }

    private var targetCanvas: some View {
        GeometryReader { geometry in
            let targets = TapAtTargetLayout.targets(in: geometry.size)
            let canvasOrigin = geometry.frame(in: .global).origin

            Canvas { context, _ in
                for (index, target) in targets.enumerated() {
                    let color = target.id == flashedTargetID ? theme.surface : targetColors[index]
                    draw(target, color: color, in: &context)
                    drawLabel(for: target, in: &context)
                }

                if showsCrosshairs {
                    for target in targets {
                        drawCrosshair(at: target.center, in: &context)
                    }
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onEnded { value in
                        recordTap(
                            value.location,
                            canvasOrigin: canvasOrigin,
                            targets: targets
                        )
                    }
            )
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tap target canvas")
    }

    private var resultPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(lastResult ?? "Nothing tapped yet")
                .font(theme.typography.bodyMedium)
                .foregroundStyle(theme.textPrimary)
                .accessibilityIdentifier("tapat-last-result")

            Text(TapAtTargetLayout.summary(hitTargetIDs: hitTargetIDs, backgroundMisses: backgroundMisses))
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)
                .accessibilityIdentifier("tapat-summary")

            HStack {
                Button("Reset") {
                    hitTargetIDs.removeAll()
                    backgroundMisses = 0
                    lastResult = nil
                    flashedTargetID = nil
                    flashToken = UUID()
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
                .accessibilityIdentifier("tapat-reset")

                Spacer()

                Toggle("Crosshairs", isOn: $showsCrosshairs)
                    .foregroundStyle(theme.textPrimary)
                    .tint(theme.primary)
                    .font(theme.typography.labelMedium)
                    .fixedSize()
                    .accessibilityIdentifier("tapat-crosshairs-toggle")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
    }

    private func draw(
        _ target: TapAtTargetLayout.Target,
        color: Color,
        in context: inout GraphicsContext
    ) {
        switch target.kind {
        case .circle:
            context.fill(Path(ellipseIn: target.rect), with: .color(color))
        case .square, .horizontalBar, .verticalBar:
            context.fill(Path(target.rect), with: .color(color))
        }
    }

    private func drawLabel(
        for target: TapAtTargetLayout.Target,
        in context: inout GraphicsContext
    ) {
        let isTiny = target.rect.width <= 24 || target.rect.height <= 24
        let labelPoint = isTiny
            ? CGPoint(x: target.rect.maxX + 5, y: target.center.y)
            : target.center
        let foreground: Color = isTiny ? theme.textPrimary : theme.onPrimary
        let text = Text(target.id)
            .font(isTiny ? theme.typography.labelSmall : theme.typography.labelLarge)
            .foregroundColor(foreground)
        context.draw(text, at: labelPoint)
    }

    private func drawCrosshair(at center: CGPoint, in context: inout GraphicsContext) {
        var path = Path()
        path.move(to: CGPoint(x: center.x - 5, y: center.y))
        path.addLine(to: CGPoint(x: center.x + 5, y: center.y))
        path.move(to: CGPoint(x: center.x, y: center.y - 5))
        path.addLine(to: CGPoint(x: center.x, y: center.y + 5))
        context.stroke(path, with: .color(theme.textPrimary), lineWidth: 1)
    }

    private func recordTap(
        _ point: CGPoint,
        canvasOrigin: CGPoint,
        targets: [TapAtTargetLayout.Target]
    ) {
        guard let resolution = TapAtTargetLayout.resolve(point, against: targets) else { return }

        let targetDescription = resolution.hitTargetID ?? "miss"
        let screenPoint = CGPoint(x: point.x + canvasOrigin.x, y: point.y + canvasOrigin.y)
        lastResult = String(
            format: "%@ — x: %.1f, y: %.1f pt — %.1f pt from %@ center",
            targetDescription,
            screenPoint.x,
            screenPoint.y,
            resolution.distanceFromNearestCenter,
            resolution.nearestTargetID
        )
        if let hitTargetID = resolution.hitTargetID {
            hitTargetIDs.insert(hitTargetID)
            flashedTargetID = hitTargetID
            let token = UUID()
            flashToken = token
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                guard flashToken == token else { return }
                flashedTargetID = nil
            }
        } else {
            backgroundMisses += 1
            flashedTargetID = nil
        }
    }
}

#Preview {
    NavigationStack {
        TapAtTargetsDemo()
    }
    .autoMobileTheme()
}
