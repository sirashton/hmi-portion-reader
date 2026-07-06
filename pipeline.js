/* Staged HMI portion reader — JS port of pipeline/read_video.py.
   Pure-logic core: ink extraction, connected components, self-calibrating
   glyph bank, block/index fitting, temporal log store. The OCR engine
   (tesseract.js) plugs in from the app shell.
   All coordinates follow the Python reference; keep the two in sync. */
'use strict';

const GLYPH_W = 12, GLYPH_H = 20;

/* ---------- ink mask: Otsu threshold + decisive-darkness guard ---------- */
function grayOf(imgData) {
  const { data, width, height } = imgData;
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
  }
  return { g, width, height };
}

function otsu(g) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function inkMask(imgData) {
  const { g, width, height } = grayOf(imgData);
  let gmin = 255;
  for (let i = 0; i < g.length; i++) if (g[i] < gmin) gmin = g[i];
  const thr = otsu(g);
  const guard = Math.max(60, gmin + 70);
  const ink = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) ink[i] = (g[i] < thr && g[i] <= guard) ? 1 : 0;
  return { ink, width, height };
}

/* ---------- connected components (4/8-neighbour BFS) ---------- */
function components(mask) {
  const { ink, width, height } = mask;
  const lab = new Int32Array(ink.length).fill(-1);
  const comps = [];
  const qx = new Int32Array(ink.length), qy = new Int32Array(ink.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!ink[i] || lab[i] !== -1) continue;
      const id = comps.length;
      let head = 0, tail = 0;
      qx[tail] = x; qy[tail] = y; tail++; lab[i] = id;
      let minx = x, maxx = x, miny = y, maxy = y, area = 0;
      const px = [];
      while (head < tail) {
        const cx = qx[head], cy = qy[head]; head++;
        area++; px.push(cy * width + cx);
        if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (ink[ni] && lab[ni] === -1) { lab[ni] = id; qx[tail] = nx; qy[tail] = ny; tail++; }
        }
      }
      comps.push({ x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, area, px });
    }
  }
  return { comps, lab, width };
}

/* ---------- glyph extraction: components -> normalised patches ---------- */
function glyphsOf(imgData) {
  const mask = inkMask(imgData);
  const { comps, width } = components(mask);
  if (!comps.length) return [];
  const hmax = Math.max(...comps.map(c => c.h));
  const keep = comps.filter(c => c.h >= 0.55 * hmax && c.area >= 10)
                    .sort((a, b) => a.x - b.x);
  return keep.map(c => {
    // rasterise component into its bbox then area-resample to GLYPH_W x GLYPH_H
    const bin = new Float32Array(c.w * c.h);
    for (const p of c.px) {
      const py = (p / width) | 0, pxx = p % width;
      bin[(py - c.y) * c.w + (pxx - c.x)] = 1;
    }
    const out = new Float32Array(GLYPH_W * GLYPH_H);
    for (let oy = 0; oy < GLYPH_H; oy++) {
      for (let ox = 0; ox < GLYPH_W; ox++) {
        const x0 = ox * c.w / GLYPH_W, x1 = (ox + 1) * c.w / GLYPH_W;
        const y0 = oy * c.h / GLYPH_H, y1 = (oy + 1) * c.h / GLYPH_H;
        let s = 0, n = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            s += bin[Math.min(c.h - 1, yy) * c.w + Math.min(c.w - 1, xx)]; n++;
          }
        }
        out[oy * GLYPH_W + ox] = n ? s / n : 0;
      }
    }
    return out;
  });
}

/* ---------- self-calibrating glyph bank ---------- */
class GlyphBank {
  constructor() { this.sum = {}; this.n = {}; }

  harvest(ctxOrGetter, tokens, cap = 40) {
    for (const tk of tokens) {
      const digits = (tk.text || '').replace(/[^0-9]/g, '');
      if (!digits) continue;
      if ([...digits].every(d => (this.n[d] || 0) >= cap)) continue;
      const cell = ctxOrGetter(tk);          // caller returns ImageData for token bbox
      if (!cell) continue;
      const gl = glyphsOf(cell);
      if (gl.length !== digits.length) continue;
      for (let i = 0; i < digits.length; i++) {
        const d = digits[i];
        if ((this.n[d] || 0) >= cap) continue;
        if (!this.sum[d]) this.sum[d] = new Float32Array(GLYPH_W * GLYPH_H);
        const s = this.sum[d], p = gl[i];
        for (let k = 0; k < s.length; k++) s[k] += p[k];
        this.n[d] = (this.n[d] || 0) + 1;
      }
    }
  }

  ready() {
    let ok = 0;
    for (const d of '0123456789') if ((this.n[d] || 0) >= 2) ok++;
    return ok >= 8;
  }

  classify(patch) {
    let best = null, bs = 0, second = 0;
    let np = 0;
    for (let k = 0; k < patch.length; k++) np += patch[k] * patch[k];
    np = Math.sqrt(np) + 1e-6;
    for (const d in this.sum) {
      if ((this.n[d] || 0) < 2) continue;
      const s = this.sum[d], n = this.n[d];
      let dot = 0, nt = 0;
      for (let k = 0; k < s.length; k++) {
        const t = s[k] / n;
        dot += patch[k] * t; nt += t * t;
      }
      const sim = dot / (np * (Math.sqrt(nt) + 1e-6));
      if (sim > bs) { second = bs; bs = sim; best = d; }
      else if (sim > second) second = sim;
    }
    // demand a clear winner: near-ties (e.g. 3 vs 2) are how silent wrong
    // weights get through — better to return null and use the fallback/vote
    return (bs >= 0.62 && bs - second >= 0.05)
      ? { digit: best, sim: bs } : { digit: null, sim: bs };
  }

  readIndexCell(cellImgData) {
    const gl = glyphsOf(cellImgData);
    if (gl.length < 1 || gl.length > 2) return null;
    let out = '';
    for (const p of gl) {
      const { digit } = this.classify(p);
      if (digit === null) return null;
      out += digit;
    }
    const v = parseInt(out, 10);
    return v >= 1 && v <= 40 ? v : null;
  }

  /* Weights always show exactly one decimal place, so the dot (dropped by the
     glyph height filter) is implied before the last digit: [6,4,9,7] -> 649.7 */
  readWeightCell(cellImgData) {
    const gl = glyphsOf(cellImgData);
    if (gl.length < 2 || gl.length > 5) return null;
    let out = '';
    for (const p of gl) {
      const { digit } = this.classify(p);
      if (digit === null) return null;
      out += digit;
    }
    const v = parseInt(out, 10) / 10;
    return v >= 5 && v <= 1500 ? Math.round(v * 10) / 10 : null;
  }
}

/* ---------- block/index fitting (consecutive descending) ---------- */
function fitBlockIndices(rows) {
  // rows: [{iread, t1, t2}] top->bottom; fits "consecutive descending" pns
  // and reports the winning vote count as .conf on the array
  const votes = {};
  rows.forEach((r, i) => {
    if (r.iread != null) votes[r.iread + i] = (votes[r.iread + i] || 0) + 1;
  });
  let top = null, bestN = 0;
  for (const k in votes) if (votes[k] > bestN) { bestN = votes[k]; top = +k; }
  const out = rows.map((r, i) => {
    const pn = top != null ? top - i : null;
    return { ...r, pn: pn != null && pn >= 1 ? pn : null };
  });
  out.conf = bestN;
  return out;
}

/* ---------- temporal log store ---------- */
class LogStore {
  constructor() { this.logs = []; this.nextId = 1; }

  _score(log, block, shift) {
    let hits = 0, tries = 0;
    for (const r of block.rows) {
      if (r.pn == null) continue;
      for (const [track, w] of [[1, r.t1], [2, r.t2]]) {
        if (w == null) continue;
        const cnt = log.obs[track + ':' + (r.pn + shift)];
        if (cnt) {
          tries++;
          if (topOf(cnt)[0] === w) hits++;
        }
      }
    }
    return { hits, tries };
  }

  absorb(blocks, fidx) {
    for (let bi = blocks.length - 1; bi >= 0; bi--) {   // oldest first
      const block = blocks[bi];
      if (block.rows.every(r => r.pn == null)) continue;
      let best = null, bh = 0, bshift = 0;
      for (const log of this.logs.slice(-8)) {
        for (const shift of [0, -1, 1, -2, 2]) {
          let { hits, tries } = this._score(log, block, shift);
          hits -= 0.1 * Math.abs(shift);           // prefer unshifted on ties
          if (hits >= 2 && hits > bh && (tries === 0 || hits / Math.max(tries, 1) >= 0.5)) {
            best = log; bh = hits; bshift = shift;
          }
        }
      }
      if (!best) {
        // new log only while bootstrapping or for the newest (top) block,
        // and only when the index fit is confidently supported — a weakly
        // fitted block keyed wrong would seed a bad pn baseline forever
        if ((fidx <= 2 || bi === 0) && (block.conf || 0) >= 2) {
          best = { id: this.nextId++, obs: {}, firstSeen: fidx };
          this.logs.push(best);
          bshift = 0;
        } else continue;
      }
      for (const r of block.rows) {
        if (r.pn == null) continue;
        for (const [track, w] of [[1, r.t1], [2, r.t2]]) {
          if (w == null) continue;
          const key = track + ':' + (r.pn + bshift);
          (best.obs[key] = best.obs[key] || {})[w] = (best.obs[key][w] || 0) + 1;
        }
      }
      best.lastSeen = fidx;
    }
  }

  mergeOverlaps() {
    const confirmed = log => {
      const out = {};
      for (const k in log.obs) {
        const [v, n] = topOf(log.obs[k]);
        if (n >= 2) out[k] = v;
      }
      return out;
    };
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let i = 0; i < this.logs.length; i++) {
        for (let j = i + 1; j < Math.min(i + 4, this.logs.length); j++) {
          const a = this.logs[i], b = this.logs[j];
          const ca = confirmed(a), cb = confirmed(b);
          const na = Object.keys(ca).length, nb = Object.keys(cb).length;
          if (!na || !nb) continue;
          for (const shift of [0, -1, 1, -2, 2]) {
            let hits = 0;
            for (const k in cb) {
              const [t, p] = k.split(':').map(Number);
              if (ca[t + ':' + (p + shift)] === cb[k]) hits++;
            }
            if (hits >= 2 && hits >= 0.6 * Math.min(na, nb)) {
              for (const k in b.obs) {
                const [t, p] = k.split(':').map(Number);
                const nk = t + ':' + (p + shift);
                a.obs[nk] = a.obs[nk] || {};
                for (const v in b.obs[k]) a.obs[nk][v] = (a.obs[nk][v] || 0) + b.obs[k][v];
              }
              this.logs.splice(j, 1);
              merged = true;
              break outer;
            }
          }
        }
      }
    }
  }

  /* confirmed rows in gold-CSV convention */
  emit(videoTitle, target, minVotes = 2) {
    this.mergeOverlaps();
    const out = [];
    let logNo = 0;
    for (const log of this.logs) {
      const confirmed = {};
      for (const key in log.obs) {
        const [val, n] = topOf(log.obs[key]);
        if (n >= minVotes) confirmed[key] = { val, n };
      }
      const keys = Object.keys(confirmed);
      if (keys.length < 3) continue;
      const pns = keys.map(k => +k.split(':')[1]);
      const lo = Math.min(...pns), hi = Math.max(...pns);
      logNo++;
      for (let pn = hi; pn >= lo; pn--) {
        for (const track of [1, 2]) {
          const c = confirmed[track + ':' + pn];
          if (!c) continue;
          let note = '';
          if (target && Math.abs(c.val - target) > 0.4 * target) {
            note = `${c.val}g — unusually ${c.val < target ? 'low' : 'high'}, ` +
                   `confirmed across ${c.n} frames, flagged for on-site verification`;
          }
          out.push({ video: videoTitle, track, log: logNo, pn, target,
                     weight: c.val, heel: pn === lo || pn === hi, note });
        }
      }
    }
    return out;
  }
}

function topOf(counter) {
  let bv = null, bn = 0;
  for (const k in counter) if (counter[k] > bn) { bn = counter[k]; bv = k; }
  return [parseFloat(bv), bn];
}

/* ---------- weight normalisation (shared rule) ---------- */
function normWeight(t) {
  t = (t || '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (!t) return null;
  if (t.indexOf('.') < 0) {
    if (t.length < 2) return null;
    t = t.slice(0, -1) + '.' + t.slice(-1);
  }
  const v = parseFloat(t);
  return v >= 5 && v <= 1500 ? Math.round(v * 10) / 10 : null;
}

if (typeof module !== 'undefined') {
  module.exports = { GlyphBank, LogStore, fitBlockIndices, normWeight,
                     glyphsOf, inkMask, components, otsu };
}
