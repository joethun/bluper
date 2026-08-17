// The chroma key, as a GPU pass.
//
// This mirrors the green-screen effect's canvas path pixel for pixel: keying
// compares colour rather than brightness, so the comparison runs in YUV, where a
// screen lit unevenly still sits at one place in the UV plane even where its
// luminance swings by half a stop.
//
// The working space is the sRGB-encoded texture as sampled, not linear light —
// the same space the canvas path measures its bytes in. Matching it matters more
// than being principled: the two paths have to agree on what a tolerance slider
// means, or a clip keys differently depending on which shell opened it.
//
// The caller supplies the key's UV coordinates and both band edges already in
// 0..1, so the byte-space scaling the canvas path does stays on that side of the
// boundary. Textures are uploaded with `premultiplied_alpha: false`, so RGB is
// carried through untouched and only alpha is cut.

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

// Rec. 601 luma, which is what the UV axes below are defined against.
const LUMA = vec3f(0.299, 0.587, 0.114);

/// Where a colour sits in the UV plane, luminance divided out.
fn chroma_coordinates(color: vec3f) -> vec2f {
    let luma = dot(color, LUMA);
    return vec2f(color.b - luma, color.r - luma);
}

@fragment
fn chroma_key_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);

    let key_chroma = uniforms.scalars.xy;
    let near = uniforms.scalars.z;
    // A band with no width would divide by zero in the ramp below. Widening it
    // by an epsilon degenerates to the hard cutoff such a band asks for, which
    // is what a softness of zero should look like.
    let far = max(uniforms.scalars.w, near + 1e-5);

    let distance = length(chroma_coordinates(color.rgb) - key_chroma);

    // `smoothstep` is the canvas path's `t * t * (3 - 2 * t)` with its two
    // early-outs folded in: inside `near` the ramp is 0 and the pixel is cut,
    // beyond `far` it is 1 and the pixel is left alone.
    return vec4f(color.rgb, color.a * smoothstep(near, far, distance));
}
