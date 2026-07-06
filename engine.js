/* Stage A+B for the browser: numeric-structure locate + row/block reader.
   Mirrors pipeline/read_video.py's read_frame() but anchors on the numeric
   token structure itself (two dense right-aligned weight bands + index band)
   instead of the 'Track 1/2' header text, which tesseract can't read reliably
   on tilted frames. Downstream interface (blocks of rows with pn/t1/t2) is
   identical to the Python reference.

   Requires pipeline.js (GlyphBank, fitBlockIndices, normWeight, glyphsOf). */
'use strict';

const ENGINE = (() => {

  const NUMRE = /^\d{2,4}[.,]?\d?$/;

  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[s.length >> 1];
  }

  /* ---- angle from same-row weight pairs (T1/T2 on one row) ----
     Tesseract boxes have unreliable heights, so use centre-y and require the
     pair to be genuinely co-linear; cap at plausible mount tilt. */
  function baselineAngle(toks) {
    const NUM = /^\d{2,4}[.,]?\d?$/;
    const nums = toks.filter(t => NUM.test(t.text));
    const angs = [];
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const a = nums[i], b = nums[j];
        const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
        const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
        const adx = Math.abs(dx);
        if (adx < 60 || adx > 300) continue;
        if (Math.abs(dy) > Math.min(a.h, b.h) * 0.6) continue;   // same row only
        angs.push(Math.atan2(dy, dx));
      }
    }
    if (angs.length < 3) return 0;
    const m = median(angs);
    return Math.abs(m) > 8 * Math.PI / 180 ? 0 : m;   // implausible: skip derotation
  }

  /* ---- 1-D clustering of x positions into bands ---- */
  function bands(xs, gap) {
    const s = [...xs].sort((a, b) => a - b), out = [];
    let cur = [s[0]];
    for (let i = 1; i < s.length; i++) {
      if (s[i] - s[i - 1] > gap) { out.push(cur); cur = []; }
      cur.push(s[i]);
    }
    out.push(cur);
    return out.map(c => ({ x: c.reduce((a, b) => a + b, 0) / c.length, n: c.length }));
  }

  /* tokens: [{text,x,y,w,h}] in canvas coords (already derotated).
     Returns {x1,x2} = weight column RIGHT edges (columns are right-aligned,
     so right edges band far tighter than centres), or null. */
  function findColumns(toks) {
    const nums = toks.filter(t => NUMRE.test(t.text) && t.h < 60);
    if (nums.length < 6) return null;
    // weights carry a decimal dot, or 4+ digits when OCR drops the dot.
    // 3-digit dotless tokens are excluded: the graph's y-axis labels
    // (697, 682, ...) form a dense vertical band that would hijack banding.
    const weighty = nums.filter(t => /\./.test(t.text) ||
                                     t.text.replace(/[^0-9]/g, '').length >= 4);
    if (weighty.length < 5) return null;
    const bnds = bands(weighty.map(t => t.x + t.w), 26)
      .filter(b => b.n >= 2)
      .sort((a, b) => b.n - a.n)
      .slice(0, 2)
      .sort((a, b) => a.x - b.x);
    if (!bnds.length) return null;
    if (bnds.length === 1) {
      return { x1: bnds[0].x, x2: bnds[0].x + 150, single: true };
    }
    const col = bnds[1].x - bnds[0].x;
    if (col < 40 || col > 320) return null;
    return { x1: bnds[0].x, x2: bnds[1].x, single: false };
  }

  /* Read one column strip (full height) by ink analysis: components cluster
     into text lines; each line's glyphs classify into a number. Returns
     [{cy, glyphs, value}] — value null when the bank can't read the line. */
  function readStrip(imgData, bank, kind, col) {
    if (!imgData) return [];
    const mask = inkMask(imgData);
    const { comps, lab, width } = components(mask);
    const hLo = 0.06 * col, hHi = 0.22 * col;
    const keep = comps.filter(c => c.h >= hLo && c.h <= hHi && c.area >= 8 &&
                                   c.w <= 0.45 * col);
    if (!keep.length) return [];
    // cluster into lines by centre-y
    keep.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const medH = median(keep.map(c => c.h));
    const lines = [];
    for (const c of keep) {
      const cy = c.y + c.h / 2;
      const last = lines[lines.length - 1];
      if (last && cy - last.cy < medH * 0.7) { last.comps.push(c); last.cy = (last.cy + cy) / 2; }
      else lines.push({ cy, comps: [c] });
    }
    const out = [];
    for (const ln of lines) {
      ln.comps.sort((a, b) => a.x - b.x);
      const glyphs = ln.comps.map(c => {
        const bin = new Float32Array(c.w * c.h);
        for (const p of c.px) {
          const py = (p / width) | 0, pxx = p % width;
          bin[(py - c.y) * c.w + (pxx - c.x)] = 1;
        }
        const outp = new Float32Array(GLYPH_W * GLYPH_H);
        for (let oy = 0; oy < GLYPH_H; oy++) for (let ox = 0; ox < GLYPH_W; ox++) {
          const x0 = ox * c.w / GLYPH_W, x1 = (ox + 1) * c.w / GLYPH_W;
          const y0 = oy * c.h / GLYPH_H, y1 = (oy + 1) * c.h / GLYPH_H;
          let s = 0, n = 0;
          for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++)
            for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
              s += bin[Math.min(c.h - 1, yy) * c.w + Math.min(c.w - 1, xx)]; n++;
            }
          outp[oy * GLYPH_W + ox] = n ? s / n : 0;
        }
        return outp;
      });
      let value = null;
      if (bank.ready() && glyphs.length >= 1 && glyphs.length <= 5) {
        let txt = '';
        for (const g of glyphs) {
          const { digit } = bank.classify(g);
          if (digit === null) { txt = null; break; }
          txt += digit;
        }
        if (txt) {
          if (kind === 'index') {
            const v = parseInt(txt, 10);
            if (v >= 1 && v <= 40 && txt.length <= 2) value = v;
          } else if (txt.length >= 2) {
            const v = parseInt(txt, 10) / 10;   // weights show exactly 1 dp
            if (v >= 5 && v <= 1500) value = Math.round(v * 10) / 10;
          }
        }
      }
      out.push({ cy: ln.cy, n: ln.comps.length, value });
    }
    return out;
  }

  /* Build rows/blocks. Tesseract provides geometry + harvest labels + weight
     fallback; row positions and numbers come from ink-strip analysis. */
  function buildBlocks(toks, geo, bank, cellGrab, stripGrab) {
    const col = geo.x2 - geo.x1;              // spacing of column right edges
    const idxHi = geo.x1 - 0.66 * col;
    const nums = toks.filter(t => NUMRE.test(t.text) && t.x + t.w > idxHi &&
                                  t.h < 0.5 * col).sort((a, b) => a.y - b.y);
    // harvest font templates from complete reads: tokens with a decimal dot,
    // or >=4 digits dotless (full read, dot dropped). Truncations are shorter.
    bank.harvest(tk => cellGrab(tk.x - 4, tk.y - tk.h * 0.25, tk.x + tk.w + 4,
                                tk.y + tk.h * 1.25),
                 nums.filter(t => /\./.test(t.text) ||
                                  t.text.replace(/[^0-9]/g, '').length >= 4)
                     .slice(0, 30));
    // ink strips per column
    const sIdx = readStrip(stripGrab(geo.x1 - 1.60 * col, idxHi - 2), bank, 'index', col);
    const sT1  = readStrip(stripGrab(geo.x1 - 0.60 * col, geo.x1 + 0.06 * col), bank, 'w', col);
    const sT2  = geo.single ? [] :
                 readStrip(stripGrab(geo.x2 - 0.60 * col, geo.x2 + 0.06 * col), bank, 'w', col);
    if (sT1.length + sT2.length < 3) return null;
    // unify lines into rows by y
    const marks = [];
    for (const [src, arr] of [['i', sIdx], ['a', sT1], ['b', sT2]])
      for (const ln of arr) marks.push({ src, ...ln });
    marks.sort((a, b) => a.cy - b.cy);
    // pitch from the T1 strip's own line spacing (perspective skews T2 rows
    // several px lower than T1, so the merge tolerance must scale with pitch)
    const ref = (sT1.length >= 3 ? sT1 : sT2).map(l => l.cy);
    const refGaps = [];
    for (let i = 1; i < ref.length; i++) refGaps.push(ref[i] - ref[i - 1]);
    const pitch0 = median(refGaps.filter(g => g > 4)) || 0.23 * col;
    const tol = Math.max(6, 0.42 * pitch0);
    const rows = [];
    for (const m of marks) {
      const last = rows[rows.length - 1];
      if (last && m.cy - last.cy < tol && !last[m.src]) { last[m.src] = m; last.cy = (last.cy + m.cy) / 2; }
      else { const r = { cy: m.cy }; r[m.src] = m; rows.push(r); }
    }
    if (rows.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(rows[i].cy - rows[i - 1].cy);
    const pitch = median(gaps);
    // tesseract fallback per row for unreadable weight cells
    function tokFallback(row, right) {
      for (const tk of nums) {
        const tcy = tk.y + tk.h / 2;
        if (Math.abs(tcy - row.cy) > pitch * 0.45) continue;
        if (Math.abs((tk.x + tk.w) - right) > 0.30 * col) continue;
        // truncated reads ('22.3' from '422.3') start mid-column — a full
        // weight token must begin near the column's left edge
        if (tk.x > right - 0.33 * col) continue;
        const v = normWeight(tk.text);
        if (v != null) return v;
      }
      return null;
    }
    for (const r of rows) {
      r.t1 = r.a ? r.a.value : null;
      r.t2 = r.b ? r.b.value : null;
      if (r.t1 == null) r.t1 = tokFallback(r, geo.x1);
      if (!geo.single && r.t2 == null) r.t2 = tokFallback(r, geo.x2);
      r.iread = r.i ? r.i.value : null;
    }
    const kept = rows.filter(r => r.t1 != null || r.t2 != null || r.iread != null);
    if (kept.length < 3) return null;
    // blocks at separator gaps
    const blocks = []; let cur = [kept[0]];
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].cy - kept[i - 1].cy > 1.45 * pitch) { blocks.push(cur); cur = []; }
      cur.push(kept[i]);
    }
    blocks.push(cur);
    return blocks.map((blk, bi) => {
      const rowsFit = fitBlockIndices(
        blk.map(r => ({ iread: r.iread, t1: r.t1, t2: r.t2 })));
      return { rows: rowsFit, conf: rowsFit.conf || 0,
               isLast: bi === blocks.length - 1 };
    });
  }

  return { baselineAngle, findColumns, buildBlocks, median };
})();

if (typeof module !== 'undefined') module.exports = ENGINE;
