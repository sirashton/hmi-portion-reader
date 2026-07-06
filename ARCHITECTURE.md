# Architecture & design decisions

A record of what was built, what was tried and rejected, and why — for review.

## Problem

A bacon slicer's HMI shows a scrolling two-track list of portion weights
(`index | Track 1 g | Track 2 g`, newest on top, one block per log/back, blocks separated
by rules). The machine exports nothing. We need every `(log, portion, track) → weight`
captured reliably from a phone pointed at the screen, offline, and written to a CSV that
matches the existing analysis workflow.

Key domain facts that shaped the design:
- Portion indices **descend to the block bottom but do not always end at 1** (logs ending
  at 3 are common) → indices must be *read*, not inferred from row counts alone.
- Tracks are not in step: **cells can be blank** on either track.
- First/last portions of each log (heels) are the analytically interesting ones — exactly
  the rows most at risk at recording boundaries, so boundary handling matters.
- Real anomalies exist (e.g. a genuine 1268.9 g double portion in the reference data) —
  the reader must report them flagged, not "correct" them.

## The three-stage pipeline

### Stage A — locate (drift/tilt tolerant, no manual framing)

Approaches tried, in order:

1. **Manual ROI box** (v1 MVP): works but operator-dependent and brittle to bumps.
2. **'Track 1/Track 2' header text as anchor**: works with PP-OCR in the Python
   reference; **fails in the browser** — tesseract cannot reliably read the small header
   text on tilted frames (returns nothing or "Tracks").
3. **Coloured header dots (green/red) as landmarks**: rejected after measurement — through
   a camera the "red" dot is dark magenta (HSV hue ≈ 142), saturation/brightness collapse,
   JPEG shifts hues; too fragile under line lighting.
4. **Numeric-structure locate (adopted for JS)**: the weight columns themselves are the
   most reliable landmark. Cluster numeric tokens' **right edges** (columns are
   right-aligned, so right edges band far tighter than centres). Only tokens with a
   decimal dot or ≥4 digits participate — 3-digit dotless tokens are excluded because the
   trend graph's y-axis labels (697, 682, …) form a dense vertical band that would hijack
   clustering. Tilt is the median angle of same-row token pairs (centre-y, co-linearity
   required, capped at ±8°) and is corrected by redrawing the frame; the correction is
   cached so steady-state costs one OCR pass.

### Stage B — read (the OCR engine is a detector, not a recogniser)

The pivotal finding: **general OCR is not accurate enough at character level for this
font/size**, in two distinct ways.

- Scene-text OCR (PP-OCR *and* tesseract) cannot read the isolated 1–2 digit index
  cells (detectors don't fire on lone glyphs; the recogniser reads '1' for '11' at 0.32
  confidence).
- tesseract truncates and substitutes characters in weights ('422.3'→'22.3',
  '673.8'→'613.8') and drops whole rows.

The solution is a **self-calibrating glyph bank**: every frame, digit templates are
harvested from weight tokens whose text is confidently known (complete reads: containing
a dot, or ≥4 digits), by pairing Otsu-ink connected components with the known digit
string. Weights and index cells are then read by cosine template matching (12×20
normalised patches, threshold 0.62, winner margin ≥0.05 to kill 3↔2 confusions).
Weights display exactly one decimal, so the dot glyph can be ignored: digits `6,4,9,7`
→ 649.7. This is font-exact, self-adapting to lighting/scale, ~free computationally, and
identical in Python and JS.

Row positions come from **full-height column ink strips** (components cluster into text
lines), not OCR boxes — so OCR's sloppy/missing boxes can't lose rows. Tesseract's role
reduces to: find the columns, label harvest examples, and act as a last-resort fallback
(geometrically guarded: a fallback token must start near the column's left edge, since
truncated reads start mid-column).

Portion indices per block are fitted to the *consecutive descending* constraint by
majority vote across the block's index-cell reads — one or two bad cells get outvoted.

### Stage C — confirm (temporal merge)

- Each sampled frame yields blocks of rows. Blocks are matched to persistent **logs** by
  weight content, tolerating a ±2 portion-number shift (a single frame's bad index fit
  must not spawn a "new" log — that was the biggest failure mode found: naive
  unmatched→new-log logic turned 34 real logs into 87, because a shifted duplicate
  self-confirms).
- New logs are only created at bootstrap (first samples) or for the newest/top block,
  and only when the index fit has ≥2 supporting votes.
- A `(log, portion, track)` weight is emitted only when the same value is read in
  **≥2 frames** (mode across all sightings). A safety-net merge pass at emit combines
  any residual duplicate logs (≥60% row agreement under |shift|≤2).
- Sampling is densified near the start/end of a video (step/4 for the first 8 s / last
  12 s) so boundary rows still get two genuine sightings — without this, the last log's
  newest portions are silently dropped.
- Weights >40% off target are emitted with a *flagged for on-site verification* note
  (convention inherited from the existing analysis workflow).

**Failure philosophy: omit or flag, never guess.** All validation errors remaining are
omissions; wrong-weight count is zero on the reference video for both implementations.

## Two implementations, one algorithm

| | Python reference (`reference/`) | Browser engine (deployed) |
|---|---|---|
| OCR detector | RapidOCR (PP-OCR, ONNX) | tesseract.js (WASM, vendored) |
| Purpose | fast iteration, ground-truth scoring | the actual product |
| Locate anchor | Track headers (PP-OCR reads them) | numeric column structure |
| Everything else | identical (glyph bank, ink strips, LogStore) | identical |

Improvements are proven in Python against gold CSVs first (`gt_eval.py` aligns logs by
weight content so numbering offsets don't mask real errors), then ported. Glyph
extraction parity JS↔Python was verified numerically (cosine 0.993 on identical cells).

## Why a PWA (and not an app / server)

- **Camera access needs HTTPS** → GitHub Pages hosting (public repo kept client-neutral).
- **Offline requirement** → all engine assets vendored (~25 MB), service-worker cached;
  after first load nothing touches the network. No line wifi needed.
- **No app store** — installs from the browser (Add to Home screen), updates ship by
  bumping the SW cache version. iOS works via the same WASM path.
- Screen wake-lock is requested while running so the phone doesn't sleep mid-trial.

## Known limitations

- **Cold-start scrollback**: rows already half-scrolled-off when capture *begins* may be
  seen <2 times and omitted (3 rows on the reference video). Doesn't apply when capture
  starts before slicing.
- Processing self-paces (see README § Real-time); very slow devices sample less often,
  thinning the confirmation margin on fast lines.
- Single HMI layout family supported (the two-track "Large weighing view" and its
  single-track sibling). New layouts need stage-A constants revisited.
- Live-camera capture quality (focus/exposure on a bright HMI) has not yet been
  field-tested — recorded-video processing is fully validated.

## Future work

- Geometry caching for stage A (skip the full-frame pass when columns are stable) —
  roughly halves per-sample cost on phones.
- Trial settings tagging + searchable trial history (planned phase 2).
- Live CV-by-portion-position dashboard reusing the existing viz conventions (phase 4).
- Optional: absorb single-sighting rows at video end with an "unconfirmed" note instead
  of omission.
