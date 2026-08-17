use bytemuck::Pod;
use gpu::{GpuContext, wgpu};

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
pub(crate) struct UniformRing<T> {
    slots: Vec<(wgpu::Buffer, wgpu::BindGroup)>,
    next: usize,
    _uniform: std::marker::PhantomData<T>,
}

impl<T: Pod> UniformRing<T> {
    pub(crate) fn new(context: &GpuContext, label: &str, capacity: usize) -> Self {
        let capacity = capacity.max(1);
        let slots = (0..capacity)
            .map(|_| {
                let buffer = context.device().create_buffer(&wgpu::BufferDescriptor {
                    label: Some(label),
                    size: std::mem::size_of::<T>() as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                let bind_group = context.create_uniform_bind_group_for_buffer(label, &buffer);
                (buffer, bind_group)
            })
            .collect();
        Self {
            slots,
            next: 0,
            _uniform: std::marker::PhantomData,
        }
    }

    /// Writes `uniform` into the next slot and returns the bind group that reads
    /// it. Advancing per write is what keeps a pass from overwriting the
    /// parameters an earlier pass in the same frame is still waiting to read.
    pub(crate) fn write(&mut self, context: &GpuContext, uniform: &T) -> &wgpu::BindGroup {
        let index = self.next;
        self.next = (self.next + 1) % self.slots.len();
        let (buffer, bind_group) = &self.slots[index];
        context
            .queue()
            .write_buffer(buffer, 0, bytemuck::bytes_of(uniform));
        bind_group
    }
}
