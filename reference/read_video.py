"""Staged HMI portion reader — Python reference implementation.

Stage A  locate : full-frame OCR -> find 'Track 1'/'Track 2' headers, estimate
                  rotation, derotate, crop the list region (drift/tilt tolerant).
Stage B  read   : OCR the upscaled crop -> numeric rows -> T1/T2 by column;
                  per-row index cell read with recogniser-only OCR (detector
                  fails on isolated digits); block segmentation by separator
                  gaps; consecutive-descending index fit per block.
Stage C  merge  : match blocks across frames to persistent logs by weight
                  content; per (log, track, portion) majority vote requiring
                  >=2 confirming frames; output gold-schema CSV.

Usage:
  python read_video.py <video.mp4> [--out out.csv] [--t0 s] [--t1 s]
                       [--step s] [--target g] [--debug]
"""
import argparse, collections, csv, math, os, re, statistics, sys
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

OCR = RapidOCR(text_score=0.3)      # default 0.5 rejects small crisp index digits
NUM = re.compile(r'^\d{2,4}[.,]?\d?$')


# ---------------------------------------------------------------- stage A
def ocr_tokens(img):
    res, _ = OCR(img)
    out = []
    for box, txt, conf in (res or []):
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        out.append({'x': sum(xs) / 4, 'y': sum(ys) / 4, 'w': max(xs) - min(xs),
                    'h': max(ys) - min(ys), 't': txt.strip(), 'c': conf})
    return out


def find_headers(toks):
    t1 = t2 = None
    for tk in toks:
        low = tk['t'].lower().replace(' ', '')
        if 'track1' in low:
            t1 = tk
        elif 'track2' in low:
            t2 = tk
    return t1, t2


def locate(frame):
    """Return derotated frame + header positions in derotated coords, or None."""
    toks = ocr_tokens(frame)
    t1, t2 = find_headers(toks)
    if not (t1 and t2):
        return None
    ang = math.degrees(math.atan2(t2['y'] - t1['y'], t2['x'] - t1['x']))
    if abs(ang) > 15:
        return None
    mid = ((t1['x'] + t2['x']) / 2, (t1['y'] + t2['y']) / 2)
    M = cv2.getRotationMatrix2D(mid, ang, 1.0)
    rot = cv2.warpAffine(frame, M, (frame.shape[1], frame.shape[0]),
                         flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    def tx(p):
        return (M[0, 0] * p[0] + M[0, 1] * p[1] + M[0, 2],
                M[1, 0] * p[0] + M[1, 1] * p[1] + M[1, 2])
    p1, p2 = tx((t1['x'], t1['y'])), tx((t2['x'], t2['y']))
    return rot, p1, p2


# ---------------------------------------------------------------- stage B
def norm_weight(t):
    t = t.replace(',', '.').replace(' ', '')
    t = ''.join(c for c in t if c in '0123456789.')
    if not t:
        return None
    if '.' not in t:
        if len(t) < 2:
            return None
        t = t[:-1] + '.' + t[-1]
    try:
        v = float(t)
    except ValueError:
        return None
    return round(v, 1) if 5.0 <= v <= 1500.0 else None


GLYPH_W, GLYPH_H = 12, 20


def _ink(cell):
    g = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    _, ink = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink[g > max(60, int(g.min()) + 70)] = 0        # decisively dark pixels only
    return ink


def _glyphs(cell):
    """Ink connected-components left->right as normalised binary patches."""
    ink = _ink(cell)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    if n <= 1:
        return []
    hmax = stats[1:, cv2.CC_STAT_HEIGHT].max()
    comps = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if h < 0.55 * hmax or a < 10:              # drop decimal dots / noise
            continue
        patch = (lab[y:y + h, x:x + w] == i).astype(np.float32)
        patch = cv2.resize(patch, (GLYPH_W, GLYPH_H), interpolation=cv2.INTER_AREA)
        comps.append((x, patch))
    comps.sort(key=lambda c: c[0])
    return [p for _, p in comps]


class GlyphBank:
    """Self-calibrating digit classifier: harvests labelled glyphs from the
    weight tokens (whose text the OCR reads reliably) in the exact HMI font,
    then classifies index-cell digits by cosine similarity."""

    def __init__(self):
        self.sum = {}; self.n = collections.Counter()

    def harvest(self, crop, tokens, cap=40):
        for tk in tokens:
            digits = ''.join(c for c in tk['t'] if c.isdigit())
            if not digits or any(self.n[d] < cap for d in digits) is False:
                continue
            x0 = int(tk['x'] - tk['w'] / 2 - 4); x1 = int(tk['x'] + tk['w'] / 2 + 4)
            y0 = int(tk['y'] - tk['h'] * 0.75); y1 = int(tk['y'] + tk['h'] * 0.75)
            cell = crop[max(0, y0):y1, max(0, x0):x1]
            if cell.size == 0:
                continue
            gl = _glyphs(cell)
            if len(gl) != len(digits):
                continue                            # segmentation mismatch: skip
            for d, p in zip(digits, gl):
                if self.n[d] >= cap:
                    continue
                self.sum[d] = self.sum.get(d, np.zeros_like(p)) + p
                self.n[d] += 1

    def ready(self):
        return sum(1 for d in '0123456789' if self.n[d] >= 2) >= 8

    def classify(self, patch):
        best, bs = None, 0.0
        for d, s in self.sum.items():
            if self.n[d] < 2:
                continue
            t = s / self.n[d]
            sim = float((patch * t).sum() /
                        (np.linalg.norm(patch) * np.linalg.norm(t) + 1e-6))
            if sim > bs:
                best, bs = d, sim
        return (best, bs) if bs >= 0.60 else (None, bs)


BANK = GlyphBank()


def read_index_cell(crop, y, half, x0, x1):
    """Classify the index number in one cell via the glyph bank."""
    y0, y1 = max(0, int(y - half)), int(y + half)
    cell = crop[y0:y1, int(x0):int(x1)]
    if cell.size == 0 or cell.shape[0] < 6 or cell.shape[1] < 6:
        return None
    gl = _glyphs(cell)
    if not (1 <= len(gl) <= 2):
        return None
    out = ''
    for p in gl:
        d, _s = BANK.classify(p)
        if d is None:
            return None
        out += d
    v = int(out)
    return v if 1 <= v <= 40 else None


def read_frame(frame):
    """Full stage A+B for one frame -> list of blocks
    [{'rows':[{'pn','t1','t2','iread'}], 'sep_below':bool}] or None."""
    loc = locate(frame)
    if not loc:
        return None
    rot, (x1, y1), (x2, y2) = loc
    col = x2 - x1
    if col < 25:
        return None
    S = max(1.5, 620.0 / (col * 4))          # normalise so a column is ~155px
    H, W = rot.shape[:2]
    cx0 = max(0, int(x1 - 1.35 * col)); cx1 = min(W, int(x2 + 0.55 * col))
    cy0 = max(0, int(max(y1, y2) + 0.10 * col)); cy1 = min(H, int(max(y1, y2) + 4.9 * col))
    crop = rot[cy0:cy1, cx0:cx1]
    if crop.size == 0:
        return None
    crop = cv2.resize(crop, None, fx=S, fy=S, interpolation=cv2.INTER_CUBIC)
    # column landmarks in crop coords
    cX1 = (x1 - cx0) * S; cX2 = (x2 - cx0) * S
    split = (cX1 + cX2) / 2
    idx_hi = cX1 - 0.42 * (cX2 - cX1)         # left edge of weight col 1
    toks = ocr_tokens(crop)
    nums = [tk for tk in toks if tk['x'] > idx_hi and NUM.match(tk['t'].replace(' ', ''))
            and tk['h'] < 0.5 * (cX2 - cX1)]
    nums.sort(key=lambda t: t['y'])
    if len(nums) < 3:
        return None
    BANK.harvest(crop, nums[:24])       # keep the font templates fresh
    # cluster into rows
    med_h = statistics.median(t['h'] for t in nums)
    rows = []
    for tk in nums:
        if rows and tk['y'] - rows[-1]['y'] < med_h * 0.8:
            rows[-1]['toks'].append(tk)
            rows[-1]['y'] = min(rows[-1]['y'], tk['y'])
        else:
            rows.append({'y': tk['y'], 'toks': [tk]})
    if len(rows) < 3:
        return None
    pitch = statistics.median(rows[i + 1]['y'] - rows[i]['y'] for i in range(len(rows) - 1))
    # per-row weights + index cell read
    for r in rows:
        t1v = t2v = None
        for tk in sorted(r['toks'], key=lambda t: t['x']):
            v = norm_weight(tk['t'])
            if v is None:
                continue
            if tk['x'] < split:
                if t1v is None:
                    t1v = v
            elif t2v is None:
                t2v = v
        r['t1'], r['t2'] = t1v, t2v
        r['iread'] = read_index_cell(crop, r['y'], pitch * 0.46,
                                     max(0, cX1 - 1.30 * (cX2 - cX1)), idx_hi - 4)
    # split into blocks at separator gaps
    blocks, cur = [], [rows[0]]
    for a, b in zip(rows, rows[1:]):
        if b['y'] - a['y'] > 1.45 * pitch:
            blocks.append(cur); cur = [b]
        else:
            cur.append(b)
    blocks.append(cur)
    out = []
    for bi, blk in enumerate(blocks):
        # consecutive-descending index fit: index_i = top - i
        votes = collections.Counter()
        for i, r in enumerate(blk):
            if r['iread'] is not None:
                votes[r['iread'] + i] += 1
        top = votes.most_common(1)[0][0] if votes else None
        rows_out = []
        for i, r in enumerate(blk):
            pn = (top - i) if top is not None else None
            if pn is not None and pn < 1:
                pn = None
            rows_out.append({'pn': pn, 't1': r['t1'], 't2': r['t2'],
                             'iread': r['iread']})
        out.append({'rows': rows_out, 'top_votes': dict(votes),
                    'is_last': bi == len(blocks) - 1})
    return out


# ---------------------------------------------------------------- stage C
class LogStore:
    """Persistent logs; blocks matched to logs by (pn -> weight) content."""

    def __init__(self):
        self.logs = []           # each: {'id', 'obs': {(track,pn): Counter}, 'last_seen'}
        self.next_id = 1

    def _score(self, log, block, shift=0):
        hits = tries = 0
        for r in block['rows']:
            if r['pn'] is None:
                continue
            for track, w in ((1, r['t1']), (2, r['t2'])):
                if w is None:
                    continue
                cnt = log['obs'].get((track, r['pn'] + shift))
                if cnt:
                    tries += 1
                    if cnt.most_common(1)[0][0] == w:
                        hits += 1
        return hits, tries

    def absorb(self, blocks, fidx):
        """blocks: top(newest) -> bottom(oldest). Logs are chronological: a
        frame's bottom block is the OLDEST. Match each block to a known log —
        tolerating a small pn shift (a bad per-frame index fit must NOT spawn
        a duplicate log with shifted portion numbers) — else create."""
        for block in reversed(blocks):          # oldest first
            if all(r['pn'] is None for r in block['rows']):
                continue
            best, bh, bshift = None, 0, 0
            for log in self.logs[-8:]:
                for shift in (0, -1, 1, -2, 2):
                    h, t = self._score(log, block, shift)
                    h -= 0.1 * abs(shift)          # prefer unshifted on ties
                    if h >= 2 and h > bh and (t == 0 or h / max(t, 1) >= 0.5):
                        best, bh, bshift = log, h, shift
            if best is None:
                # new log only while bootstrapping (whole list unseen) or for
                # the newest (top) block, and only when the index fit has
                # confident support — a weakly fitted block keyed wrong would
                # seed a bad pn baseline the shift-matching then perpetuates.
                conf = max(block.get('top_votes', {}).values(), default=0)
                if (fidx <= 2 or block is blocks[0]) and conf >= 2:
                    best = {'id': self.next_id, 'obs': {}, 'first_seen': fidx}
                    self.next_id += 1
                    self.logs.append(best)
                else:
                    continue
                bshift = 0
            for r in block['rows']:
                if r['pn'] is None:
                    continue
                for track, w in ((1, r['t1']), (2, r['t2'])):
                    if w is None:
                        continue
                    best['obs'].setdefault((track, r['pn'] + bshift),
                                           collections.Counter())[w] += 1
            best['last_seen'] = fidx

    def merge_overlaps(self):
        """Safety net: merge logs that are the same physical log recorded
        twice under a pn shift (>=60% of the smaller one's confirmed rows
        agree with the other under some |shift|<=2)."""
        def confirmed(log):
            return {k: c.most_common(1)[0][0] for k, c in log['obs'].items()
                    if c.most_common(1)[0][1] >= 2}
        merged = True
        while merged:
            merged = False
            for i in range(len(self.logs)):
                for j in range(i + 1, min(i + 4, len(self.logs))):
                    a, b = self.logs[i], self.logs[j]
                    ca, cb = confirmed(a), confirmed(b)
                    if not ca or not cb:
                        continue
                    for shift in (0, -1, 1, -2, 2):
                        # shift maps b's pn -> a's pn
                        hits = sum(1 for (t, p), w in cb.items()
                                   if ca.get((t, p + shift)) == w)
                        if hits >= 2 and hits >= 0.6 * min(len(ca), len(cb)):
                            for (t, p), cnt in b['obs'].items():
                                a['obs'].setdefault((t, p + shift),
                                                    collections.Counter()).update(cnt)
                            self.logs.remove(b)
                            merged = True
                            break
                    if merged:
                        break
                if merged:
                    break


def detect_rotation(cap, nfr):
    """Some clips are filmed landscape (rotation metadata lost): probe frames
    and pick the rotation under which the Track headers can be located.
    Returns a cv2.ROTATE_* code or None for as-is."""
    for frac in (0.5, 0.25, 0.75):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(nfr * frac))
        ok, frame = cap.read()
        if not ok:
            continue
        if locate(frame):
            return None
        for code in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE,
                     cv2.ROTATE_180):
            if locate(cv2.rotate(frame, code)):
                names = {cv2.ROTATE_90_CLOCKWISE: '90cw',
                         cv2.ROTATE_90_COUNTERCLOCKWISE: '90ccw',
                         cv2.ROTATE_180: '180'}
                print(f'auto-rotation: {names[code]}', flush=True)
                return code
    return None


def run(video, t0, t1, step, target, debug=False):
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    if t1 is None:
        t1 = nfr / fps
    rot = detect_rotation(cap, nfr)
    store = LogStore()
    # sampling plan: uniform, plus densified start/end so boundary rows still
    # get >=2 genuine samples for the confirmation rule (dedup on frame no.)
    end = min(t1, nfr / fps)
    plan = set()
    t = t0
    while t < end:
        plan.add(int(t * fps)); t += step
    t = t0
    while t < min(t0 + 8, end):
        plan.add(int(t * fps)); t += step / 4
    t = max(t0, end - 12)
    while t < end:
        plan.add(int(t * fps)); t += step / 4
    plan.add(int(end * fps) - 2)
    fidx = read_ok = 0
    for fno in sorted(p for p in plan if 0 <= p < nfr - 1):
        cap.set(cv2.CAP_PROP_POS_FRAMES, fno)
        ok, frame = cap.read()
        if not ok:
            break
        if rot is not None:
            frame = cv2.rotate(frame, rot)
        f = fno
        fidx += 1
        blocks = read_frame(frame)
        if blocks:
            read_ok += 1
            store.absorb(blocks, fidx)
            if debug:
                desc = ' | '.join(
                    ','.join(str(r['pn']) for r in b['rows']) for b in blocks)
                print(f"f{fidx} t={f/fps:6.1f}s  {desc}", flush=True)
    cap.release()
    print(f"frames sampled={fidx} read_ok={read_ok} logs={len(store.logs)}", flush=True)
    return store


def emit(store, video_title, target, out_path, min_votes=2):
    store.merge_overlaps()
    rows = []
    for log in store.logs:
        confirmed = {}
        for (track, pn), cnt in log['obs'].items():
            val, n = cnt.most_common(1)[0]
            if n >= min_votes:
                confirmed[(track, pn)] = (val, n)
        if len(confirmed) < 3:
            continue                       # too thin to be a real log
        pns = [pn for _, pn in confirmed]
        lo, hi = min(pns), max(pns)
        log['emit'] = []
        for pn in range(hi, lo - 1, -1):
            for track in (1, 2):
                if (track, pn) in confirmed:
                    val, n = confirmed[(track, pn)]
                    heel = pn in (lo, hi)
                    note = ''
                    if target and abs(val - target) > 0.4 * target:
                        note = (f"{val}g — unusually "
                                f"{'low' if val < target else 'high'}, confirmed "
                                f"across {n} frames, flagged for on-site verification")
                    log['emit'].append((track, pn, val, heel, note))
    live = [l for l in store.logs if l.get('emit')]
    with open(out_path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Video title', 'Track', 'Log number', 'Portion number',
                    'Target Weight (g)', 'Weight (g)', 'Heel/End', 'Notes'])
        for i, log in enumerate(live, 1):
            for track, pn, val, heel, note in log['emit']:
                w.writerow([video_title, track, i, pn, target if target else '',
                            val, 'Heel/End' if heel else '', note])
    n = sum(len(l['emit']) for l in live)
    print(f"wrote {out_path}: {n} rows, {len(live)} logs")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--out', default=None)
    ap.add_argument('--t0', type=float, default=0)
    ap.add_argument('--t1', type=float, default=None)
    ap.add_argument('--step', type=float, default=2.0)
    ap.add_argument('--target', type=float, default=None)
    ap.add_argument('--debug', action='store_true')
    a = ap.parse_args()
    title = os.path.splitext(os.path.basename(a.video))[0]
    out = a.out or title + '_pred.csv'
    store = run(a.video, a.t0, a.t1, a.step, a.target, a.debug)
    emit(store, title, a.target, out)
