/* Real-time trial analysis — ports the PortionTrialViz semantics into the app.
   Trials (the live capture + imported CSVs) are attributed to Group A / B and
   compared: KPIs, portion-weight scatter by position, CV by position, and
   CV contribution by position ("CV explained by portion index").
   Conventions follow PortionTrialViz.html / update_viz_data.py:
   - pos = pn - min(pn in back) + 1 ; neg = pn - max(pn in back) - 1
   - slot = neg if neg >= -TAIL, else pos if pos <= TAIL, else MID
   - light-last strip: a trailing portion < 40% of target is removed and the
     negative indices shift onto the remaining portions
   - extreme portions (>160% or <40% of target) are excluded from stats and
     drawn flagged in the scatter. */
'use strict';

const ANALYSIS = (() => {
  const TAIL = 3, LIGHT_PCT = 0.40, HI_PCT = 1.60, LO_PCT = 0.40;
  const COL_A = '#e85a1a', COL_B = '#2a3847', COL_FLAG = '#b12028';

  const trials = [];   // {name, target, group:'A'|'B'|null, live:bool, rows:[{t,log,pn,w}]}

  function upsertLive(name, target, rows) {
    let t = trials.find(x => x.live);
    if (!t) { t = { name, target, group: 'A', live: true, rows: [] }; trials.push(t); }
    t.name = name; t.target = target || t.target;
    t.rows = rows.map(r => ({ t: r.track, log: r.log, pn: r.pn, w: r.weight }));
  }

  function importCsv(text, fallbackName) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const head = lines[0].split(',');
    const idx = n => head.findIndex(h => h.toLowerCase().includes(n));
    const iV = idx('video'), iT = idx('track'), iL = idx('log'), iP = idx('portion'),
          iTg = idx('target'),
          iW = head.findIndex(h => h.toLowerCase().includes('weight') &&
                                   !h.toLowerCase().includes('target'));
    const rows = []; let name = fallbackName, target = null;
    for (let i = 1; i < lines.length; i++) {
      // split respecting quotes
      const cells = lines[i].match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
      if (cells.length < 6) continue;
      if (iV >= 0 && cells[iV]) name = cells[iV];
      if (iTg >= 0 && cells[iTg]) target = parseFloat(cells[iTg]) || target;
      const w = parseFloat(cells[iW]);
      if (!isFinite(w)) continue;
      rows.push({ t: +cells[iT], log: +cells[iL], pn: +cells[iP], w });
    }
    if (!rows.length) return null;
    if (trials.some(x => !x.live && x.name === name)) name += '_2';
    const tr = { name, target, group: trials.length ? 'B' : 'A', live: false, rows };
    trials.push(tr);
    return tr;
  }

  /* ---- derive slots per trial ---- */
  function derived(tr) {
    const backs = new Map();
    for (const r of tr.rows) {
      const k = r.t + '|' + r.log;
      if (!backs.has(k)) backs.set(k, []);
      backs.get(k).push(r);
    }
    const out = [];
    const target = tr.target;
    backs.forEach(rows => {
      let lo = Infinity, hi = -Infinity;
      for (const r of rows) { if (r.pn < lo) lo = r.pn; if (r.pn > hi) hi = r.pn; }
      let effHi = hi, stripped = null;
      if (target) {                             // light-last strip
        const last = rows.find(r => r.pn === hi);
        if (last && last.w < LIGHT_PCT * target) {
          stripped = last;
          effHi = rows.reduce((m, r) => r.pn !== hi && r.pn > m ? r.pn : m, -Infinity);
        }
      }
      for (const r of rows) {
        if (r === stripped) continue;
        const pos = r.pn - lo + 1, neg = r.pn - effHi - 1;
        const slot = neg >= -TAIL ? neg : (pos <= TAIL ? pos : 'MID');
        const flag = target ? (r.w > HI_PCT * target || r.w < LO_PCT * target) : false;
        out.push({ w: r.w, pct: target ? r.w / target * 100 : null, slot, flag });
      }
    });
    return out;
  }

  function slotOrder(all) {
    const hasMid = all.some(r => r.slot === 'MID');
    const o = [];
    for (let i = 1; i <= TAIL; i++) o.push(i);
    if (hasMid) o.push('MID');
    for (let i = -TAIL; i <= -1; i++) o.push(i);
    return o;
  }

  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { if (a.length < 2) return 0; const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
  const cv = a => a.length >= 2 && mean(a) ? sd(a) / mean(a) * 100 : null;

  function groups() {
    const g = [];
    for (const key of ['A', 'B']) {
      const trs = trials.filter(t => t.group === key && t.rows.length);
      if (!trs.length) continue;
      let rows = [];
      for (const t of trs) rows = rows.concat(derived(t));
      g.push({ key, rows, clean: rows.filter(r => !r.flag),
               color: key === 'A' ? COL_A : COL_B });
    }
    return g;
  }

  /* ---- canvas helpers ---- */
  function ctx2d(cv, h) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 300;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h); return { c, w, h };
  }
  const SLOTLBL = s => s === 'MID' ? 'mid' : (s > 0 ? '+' + s : String(s));

  /* ---- charts ---- */
  function drawScatter(cvs) {
    const gs = groups(); const { c, w, h } = ctx2d(cvs, 190);
    const all = gs.flatMap(g => g.rows);
    if (!all.length) return empty(c, w, h);
    const slots = slotOrder(all);
    const M = { l: 34, r: 6, t: 8, b: 22 }, pw = w - M.l - M.r, ph = h - M.t - M.b;
    const ys = all.filter(r => r.pct != null).map(r => r.pct);
    let lo = Math.min(60, ...ys), hi = Math.max(120, ...ys);
    lo = Math.max(0, lo - 4); hi = hi + 4;
    const X = i => M.l + (i + 0.5) / slots.length * pw;
    const Y = v => M.t + (1 - (v - lo) / (hi - lo)) * ph;
    // gridline at 100%
    c.strokeStyle = '#c9d4d2'; c.setLineDash([4, 3]);
    c.beginPath(); c.moveTo(M.l, Y(100)); c.lineTo(w - M.r, Y(100)); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#7d8a89'; c.font = '10px sans-serif'; c.textAlign = 'left';
    c.fillText('100%', M.l + 2, Y(100) - 3);
    // axis labels
    c.textAlign = 'right';
    [lo + 4, hi - 4].forEach(v => c.fillText(Math.round(v) + '%', M.l - 3, Y(v) + 3));
    slots.forEach((s, i) => { c.textAlign = 'center'; c.fillText(SLOTLBL(s), X(i), h - 8); });
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    gs.forEach(g => {
      for (const r of g.rows) {
        if (r.pct == null) continue;
        const i = slots.indexOf(r.slot); if (i < 0) continue;
        c.fillStyle = r.flag ? 'rgba(177,32,40,.65)' :
          (g.key === 'A' ? 'rgba(232,90,26,.4)' : 'rgba(42,56,71,.4)');
        c.beginPath();
        c.arc(X(i) + rand() * pw / slots.length * 0.55, Y(Math.max(lo, Math.min(hi, r.pct))), 2.5, 0, 7);
        c.fill();
      }
    });
  }

  function drawCvBars(cvs) {
    const gs = groups(); const { c, w, h } = ctx2d(cvs, 170);
    const all = gs.flatMap(g => g.clean);
    if (!all.length) return empty(c, w, h);
    const slots = slotOrder(all);
    const M = { l: 34, r: 6, t: 8, b: 22 }, pw = w - M.l - M.r, ph = h - M.t - M.b;
    const vals = [];
    gs.forEach(g => slots.forEach(s => {
      const v = cv(g.clean.filter(r => r.slot === s).map(r => r.w));
      vals.push({ g, s, v });
    }));
    const vmax = Math.max(5, ...vals.filter(x => x.v != null).map(x => x.v)) * 1.12;
    const Y = v => M.t + (1 - v / vmax) * ph;
    const bw = pw / slots.length / (gs.length + 0.6);
    c.font = '10px sans-serif';
    vals.forEach(({ g, s, v }) => {
      if (v == null) return;
      const gi = gs.indexOf(g), si = slots.indexOf(s);
      const x = M.l + si * pw / slots.length + (gi + 0.35) * bw;
      c.fillStyle = g.key === 'A' ? 'rgba(232,90,26,.8)' : 'rgba(42,56,71,.8)';
      c.fillRect(x, Y(v), bw * 0.9, M.t + ph - Y(v));
      c.fillStyle = '#5a6a68'; c.textAlign = 'center';
      c.fillText(v.toFixed(1), x + bw * 0.45, Y(v) - 3);
    });
    c.fillStyle = '#7d8a89'; c.textAlign = 'center';
    slots.forEach((s, i) => c.fillText(SLOTLBL(s), M.l + (i + 0.5) * pw / slots.length, h - 8));
    c.save(); c.translate(10, M.t + ph / 2); c.rotate(-Math.PI / 2);
    c.fillText('CV %', 0, 0); c.restore();
  }

  function drawContrib(cvs) {
    const gs = groups(); const { c, w, h } = ctx2d(cvs, 170);
    const all = gs.flatMap(g => g.clean);
    if (!all.length) return empty(c, w, h);
    const slots = slotOrder(all);
    const M = { l: 34, r: 6, t: 8, b: 22 }, pw = w - M.l - M.r, ph = h - M.t - M.b;
    const vals = [];
    gs.forEach(g => {
      const cvAll = cv(g.clean.map(r => r.w));
      if (cvAll == null) return;
      slots.forEach(s => {
        const rest = g.clean.filter(r => r.slot !== s).map(r => r.w);
        const c2 = cv(rest);
        if (c2 != null) vals.push({ g, s, v: cvAll - c2 });
      });
    });
    if (!vals.length) return empty(c, w, h);
    const lo = Math.min(0, ...vals.map(x => x.v)), hi = Math.max(1, ...vals.map(x => x.v)) * 1.15;
    const Y = v => M.t + (1 - (v - lo) / (hi - lo)) * ph;
    const bw = pw / slots.length / (gs.length + 0.6);
    c.strokeStyle = '#9aa8a6'; c.beginPath(); c.moveTo(M.l, Y(0)); c.lineTo(w - M.r, Y(0)); c.stroke();
    c.font = '10px sans-serif';
    vals.forEach(({ g, s, v }) => {
      const gi = gs.indexOf(g), si = slots.indexOf(s);
      const x = M.l + si * pw / slots.length + (gi + 0.35) * bw;
      c.fillStyle = g.key === 'A' ? 'rgba(232,90,26,.8)' : 'rgba(42,56,71,.8)';
      const y0 = Y(Math.max(0, v)), y1 = Y(Math.min(0, v));
      c.fillRect(x, y0, bw * 0.9, Math.max(1, y1 - y0));
    });
    c.fillStyle = '#7d8a89'; c.textAlign = 'center';
    slots.forEach((s, i) => c.fillText(SLOTLBL(s), M.l + (i + 0.5) * pw / slots.length, h - 8));
    c.save(); c.translate(10, M.t + ph / 2); c.rotate(-Math.PI / 2);
    c.fillText('CV contribution (pp)', 0, 0); c.restore();
  }

  function empty(c, w, h) {
    c.fillStyle = '#9aa8a6'; c.font = '12px sans-serif'; c.textAlign = 'center';
    c.fillText('no data yet', w / 2, h / 2);
  }

  function kpis(el) {
    const gs = groups();
    el.innerHTML = gs.map(g => {
      const ws = g.clean.map(r => r.w);
      const c = cv(ws);
      return `<div class="kpi" style="border-top:3px solid ${g.color}">
        <div class="kt">Group ${g.key}</div>
        <div class="kv">${c != null ? c.toFixed(2) + '%' : '—'}</div>
        <div class="ks">CV · ${ws.length} portions · mean ${ws.length ? mean(ws).toFixed(1) : '—'} g</div>
      </div>`;
    }).join('') || '<div class="kpi"><div class="ks">no group data yet</div></div>';
  }

  function trialList(el, onchange) {
    el.innerHTML = trials.map((t, i) =>
      `<div class="trow"><span class="tn">${t.live ? '● ' : ''}${t.name} <em>(${t.rows.length})</em></span>
        <span class="tseg">
          <button data-i="${i}" data-g="A" class="${t.group === 'A' ? 'on-a' : ''}">A</button>
          <button data-i="${i}" data-g="B" class="${t.group === 'B' ? 'on-b' : ''}">B</button>
          <button data-i="${i}" data-g="" class="${!t.group ? 'on-x' : ''}">off</button>
        </span></div>`).join('');
    el.querySelectorAll('button').forEach(b => b.onclick = () => {
      trials[+b.dataset.i].group = b.dataset.g || null;
      onchange();
    });
  }

  return { trials, upsertLive, importCsv, drawScatter, drawCvBars, drawContrib, kpis, trialList };
})();

if (typeof module !== 'undefined') module.exports = ANALYSIS;
