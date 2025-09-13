// renderer/js/npy.js
// Robust NPY (v1/v2) parser for ArrayBuffer / Uint8Array / Node Buffer / Blob.
// Returns: { shape: number[], dtype: string, fortran: boolean, data: TypedArray }

function normalizeToArrayBuffer(input) {
  // Already ArrayBuffer
  if (input instanceof ArrayBuffer) return input;

  // TypedArray (includes Uint8Array)
  if (input && input.buffer instanceof ArrayBuffer) {
    const { buffer, byteOffset = 0, byteLength } = input;
    // Slice to exact view range to avoid DataView-on-Buffer-View mismatch
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  // Node.js Buffer (in Electron renderer it’s possible via preload)
  if (typeof Buffer !== 'undefined' && input instanceof Buffer) {
    const { buffer, byteOffset = 0, byteLength } = input;
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  // Blob (shouldn’t happen here, but keep for completeness)
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    throw new TypeError('Blob is not supported here. Convert with await blob.arrayBuffer() before parseNPY.');
  }

  throw new TypeError('Unsupported buffer type for parseNPY; need ArrayBuffer/TypedArray/Node Buffer.');
}

function readHeader(dv, offset, verMajor) {
  // NPY format:
  // magic(6) + ver(2) + header_len(2|4) + header(header_len)
  let headerLen = 0;
  let cur = offset;
  if (verMajor === 1) {
    headerLen = dv.getUint16(cur, true); cur += 2;
  } else {
    headerLen = dv.getUint32(cur, true); cur += 4;
  }
  // header is ascii py dict, padded to 16B alignment
  const bytes = new Uint8Array(dv.buffer, cur, headerLen);
  const txt = new TextDecoder('latin1').decode(bytes);
  return { header: txt, next: cur + headerLen };
}

function parseHeaderDict(txt) {
  // Example: "{'descr': '<f8', 'fortran_order': False, 'shape': (468, 3), }"
  // Normalize to JSON-ish:
  const j = txt
    .replace(/'/g, '"')
    .replace('False', 'false')
    .replace('True', 'true')
    .replace(/,\s*}/g, '}');

  // Not strictly JSON because of tuple => convert "(a, b)" -> "[a, b]"
  const shapeMatch = j.match(/"shape"\s*:\s*\(([^)]*)\)/);
  let shape = [];
  if (shapeMatch && shapeMatch[1] != null) {
    shape = shapeMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length)
      .map(Number);
  }

  const descrMatch = j.match(/"descr"\s*:\s*"([^"]+)"/);
  const fortranMatch = j.match(/"fortran_order"\s*:\s*(true|false)/i);

  const descr = descrMatch ? descrMatch[1] : '<f8';
  const fortran = !!(fortranMatch && fortranMatch[1].toLowerCase() === 'true');

  return { descr, fortran, shape };
}

export function parseNPY(buf) {
  const ab = normalizeToArrayBuffer(buf);
  const dv = new DataView(ab);

  // Magic \x93NUMPY
  if (!(dv.getUint8(0) === 0x93 &&
        dv.getUint8(1) === 0x4e &&
        dv.getUint8(2) === 0x55 &&
        dv.getUint8(3) === 0x4d &&
        dv.getUint8(4) === 0x50 &&
        dv.getUint8(5) === 0x59)) {
    throw new Error('Not a NPY file (bad magic)');
  }

  const verMajor = dv.getUint8(6);
  const verMinor = dv.getUint8(7);

  // header
  const { header, next } = readHeader(dv, 8, verMajor);
  const meta = parseHeaderDict(header);

  // dtype -> TypedArray
  let Typed;
  if (meta.descr === '<f4') Typed = Float32Array;
  else if (meta.descr === '<f8') Typed = Float64Array;
  else {
    throw new Error(`Unsupported dtype in NPY: ${meta.descr} (expect <f4 or <f8)`);
  }

  // read raw data
  const dataBytes = ab.slice(next);
  const ta = new Typed(dataBytes);

  return {
    shape: Array.isArray(meta.shape) ? meta.shape : [],
    dtype: meta.descr,
    fortran: meta.fortran,
    data: ta
  };
}

export function ensure2D(aShape) {
  // convenience: expect [N,3]
  if (!Array.isArray(aShape) || aShape.length === 0) return [0,0];
  if (aShape.length === 1) return [aShape[0], 1];
  return [aShape[0], aShape[1]];
}
