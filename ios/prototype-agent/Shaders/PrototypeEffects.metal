// The Metal presets behind `style.effects` (#15130). A spec carries data only, never shader source:
// these functions are compiled at build time by scripts/ios/prototype-effects-metallib.sh and embedded
// as bytes, because the injectable dylib has no bundle and SwiftUI's ShaderLibrary loads only
// precompiled libraries. Android's AGSL twins live in PrototypeEffectShaders.kt; keep them in step.
#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// Snaps sampling to a grid of `cell`-px squares.
[[ stitchable ]] half4 pixelate(float2 position, SwiftUI::Layer layer, float cell) {
    float2 centre = (floor(position / cell) + 0.5) * cell;
    return layer.sample(centre);
}

// Splits red and blue apart along `shift` (px) and leaves green in place.
[[ stitchable ]] half4 chromaticAberration(float2 position, SwiftUI::Layer layer, float2 shift) {
    half4 r = layer.sample(position + shift);
    half4 g = layer.sample(position);
    half4 b = layer.sample(position - shift);
    return half4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}

// Displaces pixels sideways to the travel direction `dir` by a travelling sine.
[[ stitchable ]] float2 wave(
    float2 position, float2 dir, float amplitude, float wavelength, float phase
) {
    float2 side = float2(-dir.y, dir.x);
    float t = dot(position, dir) / wavelength * 6.2831853 - phase;
    return position + side * amplitude * sin(t);
}

// Displaces pixels radially from `centre` (a 0-1 fraction of `bounds`, SwiftUI's boundingRect) by a
// decaying outgoing ring wave.
[[ stitchable ]] float2 ripple(
    float2 position, float4 bounds, float2 centre, float amplitude, float wavelength, float phase
) {
    float2 d = position - (bounds.xy + centre * bounds.zw);
    float r = length(d);
    float2 n = r > 0.001 ? d / r : float2(0.0, 0.0);
    float falloff = exp(-r / (wavelength * 6.0));
    float w = sin(r / wavelength * 6.2831853 - phase) * amplitude * falloff;
    return position + n * w;
}

static float hashCell(float2 p) {
    return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453);
}

// Seeded value noise; premultiplied output so it blends over the node.
[[ stitchable ]] half4 noise(
    float2 position, float grain, float amount, float2 seed, float mono
) {
    float2 cell = floor(position / grain) + seed;
    float n = hashCell(cell);
    float3 c = mono > 0.5 ? float3(n, n, n) : float3(n, hashCell(cell + 17.0), hashCell(cell + 31.0));
    return half4(half3(c * amount), half(amount));
}

// Four corner colours blended bilinearly; `softness` eases the blend toward the corners. The colours
// arrive premultiplied, so mixing them stays premultiplied.
[[ stitchable ]] half4 gradientMesh(
    float2 position, float4 bounds, float softness,
    half4 topStart, half4 topEnd, half4 bottomStart, half4 bottomEnd
) {
    float2 uv = clamp((position - bounds.xy) / bounds.zw, 0.0, 1.0);
    uv = mix(uv, smoothstep(0.0, 1.0, uv), softness);
    half4 top = mix(topStart, topEnd, half(uv.x));
    half4 bottom = mix(bottomStart, bottomEnd, half(uv.x));
    return mix(top, bottom, half(uv.y));
}
