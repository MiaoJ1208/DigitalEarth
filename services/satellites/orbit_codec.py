"""ORB1: little-endian decimetre ECEF, signed second differences as zigzag varints."""
import struct

HEADER = struct.Struct("<4sIii")


def encode(rows, step):
    if not rows or len(rows) > 20000 or step <= 0:
        raise ValueError("Invalid orbit block dimensions")
    start = int(rows[0][0])
    out = bytearray(HEADER.pack(b"ORB1", len(rows), start, step))
    previous = [0, 0, 0]
    velocity = [0, 0, 0]
    for i, (dt, *point) in enumerate(rows):
        if dt != start + i * step or len(point) != 3:
            raise ValueError("Irregular orbit samples")
        for axis, position in enumerate(point):
            value = round(position * 10)
            delta = value - previous[axis]
            residual = delta - velocity[axis]
            previous[axis], velocity[axis] = value, delta
            word = 2 * residual if residual >= 0 else -2 * residual - 1
            while word >= 128:
                out.append((word & 127) | 128)
                word >>= 7
            out.append(word)
    return bytes(out)

def decode(raw):
    magic, count, start, step = HEADER.unpack_from(raw)
    if magic != b"ORB1" or not 1 <= count <= 20000 or step < 1:
        raise ValueError("Invalid orbit block")
    previous, velocity = [0]*3, [0]*3
    offset = HEADER.size
    rows = []
    for i in range(count):
        point = [start + i * step]
        for axis in range(3):
            word = 0
            for shift in range(0, 49, 7):
                byte = raw[offset]
                offset += 1
                word |= (byte & 127) << shift
                if byte < 128:
                    break
            else:
                raise ValueError("Oversized orbit residual")
            velocity[axis] += (word >> 1) ^ -(word & 1)
            previous[axis] += velocity[axis]
            point.append(previous[axis] / 10)
        rows.append(point)
    if offset != len(raw):
        raise ValueError("Unexpected trailing orbit data")
    return rows


# ORF1 has a 20-byte header followed by 12-byte ECEF decimetre records.
FIXED_HEADER = struct.Struct("<4sIqI")
FIXED_POINT = struct.Struct("<iii")
SOURCE_STEP = 10
SOURCE_DURATION = 86400


def encode_fixed(rows, epoch):
    if len(rows) != SOURCE_DURATION // SOURCE_STEP + 1:
        raise ValueError("Incomplete fixed orbit source")
    raw = bytearray(FIXED_HEADER.size + len(rows) * FIXED_POINT.size)
    FIXED_HEADER.pack_into(raw, 0, b"ORF1", len(rows), epoch, SOURCE_STEP)
    for i, (dt, x, y, z) in enumerate(rows):
        if dt != i * SOURCE_STEP:
            raise ValueError("Irregular fixed orbit samples")
        FIXED_POINT.pack_into(raw, FIXED_HEADER.size + i * FIXED_POINT.size,
                              round(x * 10), round(y * 10), round(z * 10))
    return raw


def fixed_window(raw, epoch, duration, step):
    magic, count, start, spacing = FIXED_HEADER.unpack_from(raw)
    offset = epoch - start
    if (magic != b"ORF1" or spacing != SOURCE_STEP or step <= 0 or step % spacing or
        offset < 0 or offset % spacing or duration < 0 or duration % step or
        offset + duration > (count - 1) * spacing or
        len(raw) != FIXED_HEADER.size + count * FIXED_POINT.size):
        raise ValueError("Invalid fixed orbit window")
    rows = []
    for t in range(0, duration + 1, step):
        pos = FIXED_HEADER.size + (offset + t) // spacing * FIXED_POINT.size
        x, y, z = FIXED_POINT.unpack_from(raw, pos)
        rows.append([t, x / 10, y / 10, z / 10])
    return rows
