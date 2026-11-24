import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FixedOrbit, acceptFixedOrbit } from '../src/features/satellites/fixedOrbit.ts';

test('fixed records support signed coordinates, nonzero windows and 30-second strides', () => {
  const epoch = 1_750_000_000;
  const raw = new ArrayBuffer(20 + 8641 * 12);
  const data = new DataView(raw);
  data.setUint32(0, 0x4f524631);
  data.setUint32(4, 8641, true);
  data.setBigInt64(8, BigInt(epoch), true);
  data.setUint32(16, 10, true);
  for (let i = 0; i <= 8640; i++) {
    data.setInt32(20 + 12*i, -10*i, true);
    data.setInt32(24 + 12*i, 10*i, true);
  }
  const window = new FixedOrbit(raw, epoch, epoch + 64800, 300, 30);
  assert.equal(window.count, 11); // Both playback endpoints are available for interpolation.
  assert.equal(window.coordinate(0, 0), -6480);
  assert.equal(window.coordinate(1, 1), 6483);
  assert.equal(window.overview().at(-2), 6510);
  const day = new FixedOrbit(raw, epoch, epoch, 86400, 10);
  assert.equal(day.overview().length, 721 * 3);
  assert.equal(day.coordinate(8640, 0), -8640);
  assert.throws(() => new FixedOrbit(raw, epoch, epoch + 1, 300, 30));
  assert.throws(() => new FixedOrbit(raw, epoch, epoch + 10, 86400, 10));
  assert.throws(() => new FixedOrbit(raw.slice(0, -1), epoch, epoch, 300, 10));
});

test('plain HTTP verifies the complete pack and rejects changed bytes', async t => {
  t.mock.getter(globalThis, 'crypto', () => ({} as Crypto));
  const bytes = new ArrayBuffer(20 + 8641 * 12);
  const header = new DataView(bytes);
  header.setUint32(0, 0x4f524631);
  header.setUint32(4, 8641, true);
  header.setUint32(16, 10, true);
  const digest = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const verify = () => acceptFixedOrbit(bytes, '/pack', digest, 0, 0, 86400, 10);
  assert.equal((await verify()).count, 8641);
  header.setInt32(20, 1, true);
  await assert.rejects(verify(), /校验失败/);
});
