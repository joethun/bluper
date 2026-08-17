// The colour half of the CSS filter shorthand, one entry point per function.
//
// These exist because the adjustment panel is built on a CSS filter chain and
// `CanvasRenderingContext2D.filter` is inert in WebKitGTK — it parses, reads
// back, and changes nothing, so on the desktop shell every slider was a no-op.
// Running the same functions here keeps one definition of what a slider means
// while moving the work to the GPU the compositor already has.
//
// Matching the browser matters more than being principled: the coefficients and
// the sRGB (non-linearised) working space are the ones in the Filter Effects
// spec, which is what the web build gets from `ctx.filter`. Textures are
// uploaded with `premultiplied_alpha: false`, so RGB is adjusted directly and
// alpha is carried through untouched.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

// Luminance coefficients shared by `saturate` and `hue-rotate`.
const LUMA = vec3f(0.213, 0.715, 0.072);

fn sample_source(input: VertexOutput) -> vec4f {
    return textureSample(input_texture, input_sampler, input.tex_coord);
}

fn amount() -> f32 {
    return uniforms.scalars.x;
}

@fragment
fn brightness_main(input: VertexOutput) -> @location(0) vec4f {
    let color = sample_source(input);
    return vec4f(clamp(color.rgb * amount(), vec3f(0.0), vec3f(1.0)), color.a);
}

@fragment
fn contrast_main(input: VertexOutput) -> @location(0) vec4f {
    let color = sample_source(input);
    let adjusted = (color.rgb - vec3f(0.5)) * amount() + vec3f(0.5);
    return vec4f(clamp(adjusted, vec3f(0.0), vec3f(1.0)), color.a);
}

@fragment
fn saturate_main(input: VertexOutput) -> @location(0) vec4f {
    let color = sample_source(input);
    // Lerping towards luminance is the spec's saturation matrix written out:
    // at 0 every channel collapses to luma, at 1 nothing moves, and values
    // above 1 extrapolate away from grey.
    let luma = dot(color.rgb, LUMA);
    let adjusted = mix(vec3f(luma), color.rgb, amount());
    return vec4f(clamp(adjusted, vec3f(0.0), vec3f(1.0)), color.a);
}

@fragment
fn hue_rotate_main(input: VertexOutput) -> @location(0) vec4f {
    let color = sample_source(input);
    let radians = amount() * 0.017453292519943295;
    let c = cos(radians);
    let s = sin(radians);

    // The hue-rotate matrix from the Filter Effects spec, by row.
    let row_r = vec3f(
        0.213 + c * 0.787 - s * 0.213,
        0.715 - c * 0.715 - s * 0.715,
        0.072 - c * 0.072 + s * 0.928,
    );
    let row_g = vec3f(
        0.213 - c * 0.213 + s * 0.143,
        0.715 + c * 0.285 + s * 0.140,
        0.072 - c * 0.072 - s * 0.283,
    );
    let row_b = vec3f(
        0.213 - c * 0.213 - s * 0.787,
        0.715 - c * 0.715 + s * 0.715,
        0.072 + c * 0.928 + s * 0.072,
    );

    let adjusted = vec3f(
        dot(color.rgb, row_r),
        dot(color.rgb, row_g),
        dot(color.rgb, row_b),
    );
    return vec4f(clamp(adjusted, vec3f(0.0), vec3f(1.0)), color.a);
}

@fragment
fn invert_main(input: VertexOutput) -> @location(0) vec4f {
    let color = sample_source(input);
    let adjusted = mix(color.rgb, vec3f(1.0) - color.rgb, amount());
    return vec4f(clamp(adjusted, vec3f(0.0), vec3f(1.0)), color.a);
}
