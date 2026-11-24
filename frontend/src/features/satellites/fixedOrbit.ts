/** Byte-addressable view of a display window in a complete ORF1 object. */
export class FixedOrbit {
  readonly step: number;
  readonly count: number;
  private readonly view: DataView;
  private readonly offset: number;
  private readonly stride: number;

  constructor(bytes: ArrayBuffer, sourceEpoch: number, epoch: number, duration: number, step: number) {
    this.step = step;
    this.view = new DataView(bytes);
    const start = epoch - sourceEpoch;
    if (bytes.byteLength < 20 || this.view.getUint32(0) !== 0x4f524631 ||
        Number(this.view.getBigInt64(8, true)) !== sourceEpoch || this.view.getUint32(16, true) !== 10 ||
        !Number.isSafeInteger(start) || start < 0 || start % 10 || ![10, 30].includes(step) ||
        !Number.isSafeInteger(duration) || duration <= 0 || duration % step ||
        this.view.getUint32(4, true) !== 8641 || bytes.byteLength !== 20 + 8641 * 12 ||
        start + duration > 86400) throw new Error('定长轨迹的采样范围无效');
    this.count = duration / step + 1;
    this.offset = 20 + start / 10 * 12;
    this.stride = step / 10 * 12;
  }

  coordinate(index: number, axis: number) {
    return this.view.getInt32(this.offset + index * this.stride + axis * 4, true) / 10;
  }

  overview() {
    const coords: number[] = [];
    const stride = Math.ceil((this.count - 1) / 720);
    const append = (i: number) => coords.push(this.coordinate(i, 0), this.coordinate(i, 1), this.coordinate(i, 2));
    for (let i = 0; i < this.count - 1; i += stride) append(i);
    append(this.count - 1);
    return coords;
  }
}

let opening: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('digitalearth-orbits', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('packs');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); opening = undefined; };
      resolve(req.result);
    };
  }).catch(error => { opening = undefined; throw error; });
}

async function read(key: string): Promise<ArrayBuffer | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction('packs').objectStore('packs').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function write(key: string, bytes: ArrayBuffer) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('packs', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.objectStore('packs').put(bytes, key);
  });
}

export async function loadFixedOrbit(url: string, digest: string, sourceEpoch: number, epoch: number,
  duration: number, step: number, signal: AbortSignal) {
  const open = (bytes: ArrayBuffer) => new FixedOrbit(bytes, sourceEpoch, epoch, duration, step);
  const cached = await read(url).catch(() => undefined);
  signal.throwIfAborted();
  if (cached) {
    try { return open(cached); } catch { /* Replace invalid cached data after a verified download. */ }
  }
  const response = await fetch(url, {signal});
  if (!response.ok) throw new Error('单星轨迹下载失败');
  const bytes = await response.arrayBuffer();
  return acceptFixedOrbit(bytes, url, digest, sourceEpoch, epoch, duration, step);
}

export async function acceptFixedOrbit(bytes: ArrayBuffer, url: string, digest: string, sourceEpoch: number, epoch: number, duration: number, step: number) {
  const hash = globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    : (await import('js-sha256')).sha256(bytes);
  if (hash !== digest)
    throw new Error('单星轨迹校验失败');
  const orbit = new FixedOrbit(bytes, sourceEpoch, epoch, duration, step);
  await write(url, bytes).catch(() => undefined); // Storage quota and private browsing can disable persistence.
  return orbit;
}
