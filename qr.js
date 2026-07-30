/**
 * QR Code Model 2 — byte mode, error correction level M, versions 1–10.
 * Reed-Solomon over GF(2^8), full block interleaving, all eight mask patterns
 * scored against the ISO penalty rules.
 *
 * Verified against the published Reed-Solomon reference vector and by
 * round-trip decode of the placed, masked matrix. See test/qr.test.js.
 */

export const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
export const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

export function polyMul(a, b) {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] ^= gfMul(a[i], b[j]);
  return r;
}
export function rsGenerator(n) { let g = [1]; for (let i = 0; i < n; i++) g = polyMul(g, [1, GF_EXP[i]]); return g; }
export function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (!coef) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
  }
  return Array.from(res.slice(data.length));
}

export const QR_ECC_M = {
  1: { data: 16, ec: 10, blocks: [[1, 16]] }, 2: { data: 28, ec: 16, blocks: [[1, 28]] },
  3: { data: 44, ec: 26, blocks: [[1, 44]] }, 4: { data: 64, ec: 18, blocks: [[2, 32]] },
  5: { data: 86, ec: 24, blocks: [[2, 43]] }, 6: { data: 108, ec: 16, blocks: [[4, 27]] },
  7: { data: 124, ec: 18, blocks: [[4, 31]] }, 8: { data: 154, ec: 22, blocks: [[2, 38], [2, 39]] },
  9: { data: 182, ec: 22, blocks: [[3, 36], [2, 37]] }, 10: { data: 216, ec: 26, blocks: [[4, 43], [1, 44]] },
};
export const QR_ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
export const qrSize = (v) => 17 + 4 * v;

export function qrPickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) if (4 + (v <= 9 ? 8 : 16) + byteLen * 8 <= QR_ECC_M[v].data * 8) return v;
  throw new Error("QR payload exceeds v10-M capacity");
}
export function qrDataCodewords(bytes, version) {
  const spec = QR_ECC_M[version], cap = spec.data * 8, bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  const PAD = [0xec, 0x11];
  let k = 0;
  while (cw.length < spec.data) cw.push(PAD[k++ % 2]);
  return cw;
}
export function qrInterleave(dataCw, version) {
  const spec = QR_ECC_M[version], blocks = [];
  let off = 0;
  for (const [count, len] of spec.blocks) for (let i = 0; i < count; i++) {
    const d = dataCw.slice(off, off + len); off += len;
    blocks.push({ data: d, ec: rsEncode(d, spec.ec) });
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length)), out = [];
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < spec.ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}
export function qrTemplate(version) {
  const n = qrSize(version);
  const m = Array.from({ length: n }, () => new Array(n).fill(null));
  const set = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) m[r][c] = v; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const on = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(r0 + r, c0 + c, on ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
  const centres = QR_ALIGN[version], last = centres[centres.length - 1];
  for (const r of centres) for (const c of centres) {
    if ((r === 6 && c === 6) || (r === 6 && c === last) || (c === 6 && r === last)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
  }
  set(n - 8, 8, 1);
  for (let i = 0; i <= 8; i++) { if (m[8][i] === null) set(8, i, 0); if (m[i][8] === null) set(i, 8, 0); }
  for (let i = n - 8; i < n; i++) { set(8, i, 0); set(i, 8, 0); }
  if (version >= 7) for (let i = 0; i < 18; i++) {
    const r = Math.floor(i / 3), c = i % 3;
    set(n - 11 + c, r, 0); set(r, n - 11 + c, 0);
  }
  return m;
}
export function qrDataPositions(version) {
  const tpl = qrTemplate(version), n = qrSize(version), pos = [];
  let upward = true;
  for (let col = n - 1; col >= 0; col -= 2) {
    const c1 = col === 6 ? col - 1 : col;
    const cols = c1 === 0 ? [0] : [c1, c1 - 1];
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (const c of cols) if (c >= 0 && tpl[row][c] === null) pos.push([row, c]);
    }
    if (col === 6) col -= 1;
    upward = !upward;
  }
  return pos;
}
export const QR_MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];
export function bchFormat(data) {
  let d = data << 10;
  for (let i = 4; i >= 0; i--) if ((d >>> (i + 10)) & 1) d ^= 0x537 << i;
  return ((data << 10) | d) ^ 0x5412;
}
export function bchVersion(v) {
  let d = v << 12;
  for (let i = 5; i >= 0; i--) if ((d >>> (i + 12)) & 1) d ^= 0x1f25 << i;
  return (v << 12) | d;
}
export function qrPenalty(m) {
  const n = m.length;
  let score = 0;
  const runs = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += 3 + (run - 5); run = 1; }
    }
    return run >= 5 ? s + 3 + (run - 5) : s;
  };
  for (let r = 0; r < n; r++) score += runs(m[r]);
  for (let c = 0; c < n; c++) score += runs(m.map((row) => row[c]));
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  const P = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], RP = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const at = (line, i, p) => p.every((v, k) => line[i + k] === v);
  for (let r = 0; r < n; r++) for (let c = 0; c + 11 <= n; c++) if (at(m[r], c, P) || at(m[r], c, RP)) score += 40;
  for (let c = 0; c < n; c++) {
    const col = m.map((row) => row[c]);
    for (let r = 0; r + 11 <= n; r++) if (at(col, r, P) || at(col, r, RP)) score += 40;
  }
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}
export function encodeQR(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = qrPickVersion(bytes.length), n = qrSize(version);
  const codewords = qrInterleave(qrDataCodewords(bytes, version), version);
  const positions = qrDataPositions(version), bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  while (bits.length < positions.length) bits.push(0);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = qrTemplate(version).map((row) => row.slice());
    positions.forEach(([r, c], i) => { m[r][c] = bits[i] ^ (QR_MASKS[mask](r, c) ? 1 : 0); });
    const fmt = bchFormat((0b00 << 3) | mask);
    for (let i = 0; i <= 5; i++) m[8][i] = (fmt >>> (14 - i)) & 1;
    m[8][7] = (fmt >>> 8) & 1; m[8][8] = (fmt >>> 7) & 1; m[7][8] = (fmt >>> 6) & 1;
    for (let i = 9; i <= 14; i++) m[14 - i][8] = (fmt >>> (14 - i)) & 1;
    for (let i = 0; i <= 7; i++) m[n - 1 - i][8] = (fmt >>> i) & 1;
    for (let i = 8; i <= 14; i++) m[8][n - 15 + i] = (fmt >>> i) & 1;
    m[n - 8][8] = 1;
    if (version >= 7) {
      const vi = bchVersion(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vi >>> i) & 1;
        m[Math.floor(i / 3)][n - 11 + (i % 3)] = bit;
        m[n - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }
    const p = qrPenalty(m);
    if (!best || p < best.penalty) best = { matrix: m, penalty: p, mask, version };
  }
  return best;
}
export function decodeQR(matrix, version, mask) {
  const positions = qrDataPositions(version);
  const bits = positions.map(([r, c]) => matrix[r][c] ^ (QR_MASKS[mask](r, c) ? 1 : 0));
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  const spec = QR_ECC_M[version], lens = [];
  for (const [count, len] of spec.blocks) for (let i = 0; i < count; i++) lens.push(len);
  const blocks = lens.map(() => []);
  let idx = 0;
  for (let i = 0; i < Math.max(...lens); i++)
    for (let b = 0; b < lens.length; b++) if (i < lens[b]) blocks[b].push(cw[idx++]);
  const data = blocks.flat();
  let bit = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) { v = (v << 1) | ((data[Math.floor(bit / 8)] >>> (7 - (bit % 8))) & 1); bit++; }
    return v;
  };
  if (read(4) !== 0b0100) throw new Error("unexpected QR mode");
  const len = read(version <= 9 ? 8 : 16), out = [];
  for (let i = 0; i < len; i++) out.push(read(8));
  return new TextDecoder().decode(new Uint8Array(out));
}
