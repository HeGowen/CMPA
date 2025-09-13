// main/eeg_buffer.js
const DEFAULT_FS = 250;

function decodeInt24LE(b0, b1, b2) {
  let v = (b0 | (b1 << 8) | (b2 << 16)) >>> 0;
  if (v & 0x800000) v |= 0xFF000000;
  return (v << 8) >> 8;
}

class EEGBuffer {
  constructor({ fs = DEFAULT_FS, channels = 4, capacitySec = 60, byteFormat = 'lsb24', order = ['EEG','EOG-L','EOG-R','M1'] } = {}) {
    this.fs = fs; this.channels = channels; this.order = order;
    this.capacity = (fs * capacitySec) | 0;
    this.buffers = Array.from({length: channels}, () => new Float64Array(this.capacity));
    this.writeIdx = 0; this.filled = 0;
    this.byteFormat = byteFormat; // 'lsb24' | 'msb24'
  }

  pushPacket(packet) {
    if (!packet || packet.length < 8) return;
    if (packet[0] !== 0xFC || packet[1] !== 0xFA) return; // EEG帧
    const body = packet.subarray(6);
    const stride = this.channels * 3;
    const n = Math.floor(body.length / stride);
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        const b0 = body[off++], b1 = body[off++], b2 = body[off++];
        const v = this.byteFormat === 'lsb24'
          ? decodeInt24LE(b0, b1, b2)
          : decodeInt24LE(b2, b1, b0);
        const idx = this.writeIdx % this.capacity;
        this.buffers[c][idx] = v;
      }
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
      if (this.filled < this.capacity) this.filled++;
    }
  }

  takeWindow(windowSamples) {
    if (this.filled < windowSamples) return null;
    const out = this.buffers.map(() => new Float64Array(windowSamples));
    const start = (this.writeIdx - windowSamples + this.capacity) % this.capacity;
    for (let c = 0; c < this.channels; c++) {
      if (start + windowSamples <= this.capacity) {
        out[c].set(this.buffers[c].subarray(start, start + windowSamples));
      } else {
        const first = this.capacity - start;
        out[c].set(this.buffers[c].subarray(start));
        out[c].set(this.buffers[c].subarray(0, windowSamples - first), first);
      }
    }
    return out.map(a => Array.from(a));
  }
}

module.exports = { EEGBuffer };
