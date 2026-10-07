#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>

using namespace metal;

// Static black grain on a transparent background, matching Android's sine hash.
[[ stitchable ]] half4 crayonGrain(
    float2 position, half4 color, float cellSize, float maxAlpha, float seed,
    float hashX, float hashY, float hashScale
) {
    float2 cell = floor(position / cellSize);
    float grain = fract(sin(dot(cell + seed, float2(hashX, hashY))) * hashScale);
    return half4(0.0h, 0.0h, 0.0h, half(grain * maxAlpha) * color.a);
}
