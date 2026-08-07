use gpu::wgpu;

/// A small ring of (uniform buffer, bind group) pairs that cycle within a
/// frame. Cheap to reuse at the steady state and lets each GPU command stream
/// see a stable buffer reference, which is what bind groups require.
///
/// Cycles `capacity` slots before wrapping. With one slot consumed per layer
/// (and one per blend / mask pass), the slot index in a frame is bounded by
/// the per-frame layer count, and the ring only needs to span enough slots
/// to stay clear of the GPU reading the prior frame's contents. wgpu's queue
/// orders writes before any subsequent operations on the same buffer, so a
/// ring of modest size is correct even when the GPU is one or two frames
/// behind on submit.
pub(crate) struct UniformRing {
    buffers: Vec<wgpu::Buffer>,
    bind_groups: Vec<wgpu::BindGroup>,
    next: usize,
}

impl UniformRing {
    pub(crate) fn new(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        size: u64,
        label: &'static str,
        capacity: usize,
    ) -> Self {
        let capacity = capacity.max(1);
        let mut buffers = Vec::with_capacity(capacity);
        let mut bind_groups = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                }],
            });
            buffers.push(buffer);
            bind_groups.push(bind_group);
        }
        Self {
            buffers,
            bind_groups,
            next: 0,
        }
    }

    /// Hand the caller the next (buffer, bind group) pair. The borrow is
    /// short-lived; the caller uses it on the same line to avoid holding a
    /// reference across ring mutations.
    pub(crate) fn cycle(&mut self) -> (&wgpu::Buffer, &wgpu::BindGroup) {
        let index = self.next;
        self.next = (self.next + 1) % self.buffers.len();
        (&self.buffers[index], &self.bind_groups[index])
    }
}
