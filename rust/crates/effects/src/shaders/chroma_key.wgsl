// The chroma key, as a GPU pass.
//
// Mirrors the green-screen effect's canvas path pixel for pixel. Both run
// the same difference key: each pixel is projected onto the key colour's
// 3D line in RGB space, and the perpendicular distance to that line drives
// the matte. Pixels that land on the line are background regardless of how
// bright or dim the lighting was; pixels that fall off it are foreground.
// A minimum similarity floor keeps black and grey pixels (which sit at the
// origin) from being keyed out by their zero perpendicular distance.
//
// Surviving pixels are despilled — the green channel is pulled toward the
// average of red and blue — to remove the green cast the screen leaves on
// the subject.
//
// Working space is the sRGB-encoded texture as sampled (0..1), not linear
// light — the same space the canvas path measures its bytes in. Matching
// it matters more than being principled: the two paths have to agree on
// what a tolerance slider means, or a clip keys differently depending on
// which shell opened it.
//
// Uniform layout (the chroma-key shader is the only consumer of
// `resolution`/`direction`, which exist for the other passes — every field
// below is repurposed as a scalar input here):
//
//   resolution.x, resolution.y        = key colour red, green (0..1)
//   direction.x                       = key colour blue (0..1)
//   direction.y                       = key colour length (precomputed)
//   scalars.x                         = minimum similarity (0..1)
//   scalars.y, scalars.z              = near, far (perpendicular distance)
//   scalars.w                         = spill reduction (0..1)
//
// Textures are uploaded with `premultiplied_alpha: false`, so RGB is
// carried through untouched and only alpha is cut. Despill writes back to
// RGB without disturbing alpha.

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

@fragment
fn chroma_key_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);

    let key_color = vec3f(uniforms.resolution.x, uniforms.resolution.y, uniforms.direction.x);
    let key_length = uniforms.direction.y;
    let min_similarity = uniforms.scalars.x;
    let near = uniforms.scalars.y;
    // A band with no width would divide by zero in the ramp below. Widening
    // it by an epsilon degenerates to the hard cutoff such a band asks for,
    // which is what a softness of zero should look like.
    let far = max(uniforms.scalars.z, near + 1e-5);
    let spill_reduction = uniforms.scalars.w;

    let key_norm = key_color / max(key_length, 1e-5);
    let proj = dot(color.rgb, key_norm);

    var out_alpha = color.a;
    if (proj >= min_similarity * key_length) {
        let perp_vec = color.rgb - proj * key_norm;
        let perp_len_sq = dot(perp_vec, perp_vec);
        let near_sq = near * near;
        let far_sq = far * far;

        if (perp_len_sq <= near_sq) {
            out_alpha = 0.0;
        } else if (perp_len_sq < far_sq) {
            // Smoothstep in the band, matching the canvas path's
            // `t * t * (3 - 2 * t)` with its two early-outs folded in.
            let perp_len = sqrt(perp_len_sq);
            let t = (perp_len - near) / (far - near);
            out_alpha = color.a * (t * t * (3.0 - 2.0 * t));
        }
    }

    // Despill — applied only to pixels the key kept, and only where the
    // green channel sits above the red/blue average that would read as
    // neutral. A spill-reduction of zero leaves the colour untouched.
    var out_rgb = color.rgb;
    if (spill_reduction > 0.0 && color.g > (color.r + color.b) * 0.5) {
        let neutral = (color.r + color.b) * 0.5;
        let excess = color.g - neutral;
        out_rgb = vec3f(color.r, color.g - excess * spill_reduction, color.b);
    }

    return vec4f(out_rgb, out_alpha);
}