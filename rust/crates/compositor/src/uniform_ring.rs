use bytemuck::Pod;
use gpu::{GpuContext, wgpu};

/// One (uniform buffer, bind group) pair per write in a frame, reused across
/// frames. Each pass needs its parameters to stay put until the GPU runs the
/// command that reads them, and a bind group is tied to the buffer it was built
/// against, so a pass cannot share a buffer with another pass in the same frame.
///
/// [`Self::reset`] returns to slot 0 for the next frame; [`Self::write`] grows
/// the ring rather than wrapping, because wrapping inside a frame would point
/// two recorded passes at one buffer and the later write would be the one both
/// of them read — a scene with more layers than slots would draw the last
/// layer's transform for an earlier one. Growth settles at the busiest frame's
/// pass count.
pub(crate) struct UniformRing<T> {
    label: String,
    slots: Vec<(wgpu::Buffer, wgpu::BindGroup)>,
    next: usize,
    _uniform: std::marker::PhantomData<T>,
}

impl<T: Pod> UniformRing<T> {
    pub(crate) fn new(context: &GpuContext, label: &str, capacity: usize) -> Self {
        let slots = (0..capacity.max(1))
            .map(|_| Self::create_slot(context, label))
            .collect();
        Self {
            label: label.to_string(),
            slots,
            next: 0,
            _uniform: std::marker::PhantomData,
        }
    }

    fn create_slot(context: &GpuContext, label: &str) -> (wgpu::Buffer, wgpu::BindGroup) {
        let buffer = context.device().create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: std::mem::size_of::<T>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = context.create_uniform_bind_group_for_buffer(label, &buffer);
        (buffer, bind_group)
    }

    /// Hands the whole ring back for the next frame. Only safe once the frame
    /// that wrote to it has been submitted.
    pub(crate) fn reset(&mut self) {
        self.next = 0;
    }

    /// Writes `uniform` into the next slot and returns the bind group that reads
    /// it. Advancing per write is what keeps a pass from overwriting the
    /// parameters an earlier pass in the same frame is still waiting to read.
    pub(crate) fn write(&mut self, context: &GpuContext, uniform: &T) -> &wgpu::BindGroup {
        let index = self.next;
        self.next += 1;
        if index == self.slots.len() {
            self.slots.push(Self::create_slot(context, &self.label));
        }
        let (buffer, bind_group) = &self.slots[index];
        context
            .queue()
            .write_buffer(buffer, 0, bytemuck::bytes_of(uniform));
        bind_group
    }
}
