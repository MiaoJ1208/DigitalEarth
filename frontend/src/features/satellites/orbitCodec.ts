export function decodePackedOrbit(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 16 || view.getUint32(0) !== 0x4f524231) throw new Error('轨迹包头无效');
  const count = view.getUint32(4, true);
  const start = view.getInt32(8, true);
  const step = view.getInt32(12, true);
  if (count < 1 || count > 20000 || step < 1) throw new Error('轨迹包维度无效');
  const position = [0, 0, 0], velocity = [0, 0, 0];
  const xyz = new Float64Array(count * 3);
  let offset = 16;
  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      let word = 0, factor = 1;
      for (;;) {
        if (offset >= view.byteLength || factor > 2 ** 42) throw new Error('轨迹包编码无效');
        const byte = view.getUint8(offset++);
        word += (byte & 127) * factor;
        if (byte < 128) break;
        factor *= 128;
      }
      velocity[axis] += word % 2 ? -(word + 1) / 2 : word / 2;
      position[axis] += velocity[axis];
      xyz[i * 3 + axis] = position[axis] / 10;
    }
  }
  if (offset !== view.byteLength) throw new Error('轨迹包长度无效');
  return { xyz, start, step };
}

// Row representation used by the transport comparison benchmark.
export function decodeOrbit(buffer: ArrayBuffer): number[][] {
  const { xyz, start, step } = decodePackedOrbit(buffer);
  return Array.from({length: xyz.length / 3}, (_, i) =>
    [start + i * step, xyz[3*i], xyz[3*i+1], xyz[3*i+2]]);
}
