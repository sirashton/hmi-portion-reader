# HMI Portion Reader

An **offline, on-device web app** that reads a food slicer's HMI screen through a phone
camera (or from a recorded video) and logs every portion — log number, portion number,
weight per track — to a CSV. Built for lines where the slicer won't export data and the
OEM won't help: point a phone at the screen instead.

**Live app:** https://sirashton.github.io/hmi-portion-reader/
**No app store, no server, no internet at the line.** After one online load the app is
fully cached; every frame is processed on the phone itself and nothing leaves the device.

| | |
|---|---|
| Input | live rear camera **or** an uploaded video of the HMI |
| Output | `<trial>_portion_weights.csv` — `Video title, Track, Log number, Portion number, Target Weight (g), Weight (g), Heel/End, Notes` |
| Runs on | Android Chrome (primary), iOS Safari (same WASM stack) |
| Accuracy | see [Validation](#validation) |

## Quick start (phone)

1. Open the live link in Chrome → menu → **Add to Home screen** (first load needs
   internet for ~25 MB of engine assets; afterwards it works offline).
2. Enter a **Trial** name (becomes the CSV filename) and the product's **Target g**.
3. Mount the phone square to the HMI with the whole Track 1/Track 2 list in frame.
   No manual framing is required — the reader finds the list itself.
   (**▦ Mask** can restrict reading to a drawn box if other numbers are in shot.)
4. **Start.** The screen stays awake; portions appear in the table once confirmed.
5. **Stop** → the CSV downloads. `•` marks heel/end portions; red rows are auto-flagged
   unusual weights ("unusually low/high … flagged for on-site verification").

To process a recorded clip instead: **📁 Video**, pick the file, **Start** — it plays,
reads, and auto-stops at the end (CSV timestamps follow the clip).

**Visual confirmation while running:** a green box on the feed shows the area the reader
has identified (with column guides); the panel beside the feed mirrors the HMI list as
the reader currently sees it — green values are confirmed across frames, grey are still
awaiting confirmation.

**📊 Analysis** opens the real-time trial view: portion-weight scatter by position,
CV by portion position, and CV-contribution bars, with **A/B group attribution** — the
live capture is a trial (Group A by default) and previous trial CSVs can be imported and
assigned to either group for a live A-vs-B comparison of slicer settings.

**Frame archive:** every sampled frame is kept (toggleable) and downloads as a ZIP via
**⬇ Frames**, so any trial can be re-processed or verified later.

## How it works — three stages

```
frame ──A──> locate ──B──> read ──C──> confirm ──> CSV
```

**A. Locate** (`engine.js findColumns/baselineAngle`) — OCR the frame for numeric tokens
only, then find the two weight columns by clustering token **right edges** (the columns
are right-aligned). Camera tilt is estimated from same-row token pairs and corrected by
redrawing the frame rotated. No reliance on reading header text, colour marks, or manual
ROI — this survives handheld drift, tilt and distance changes.

**B. Read** (`engine.js buildBlocks` + `pipeline.js GlyphBank`) — a second OCR pass on an
upscaled crop of just the list. Crucially, **the OCR engine is only a detector**: the
actual digits are recognised by a *self-calibrating glyph matcher* — digit templates are
harvested each frame from the weight tokens (whose text is known), then every weight and
portion-index cell is read by template matching on the ink's connected components. Row
positions come from the ink itself (full-height column strips), so sloppy OCR boxes and
missed rows don't matter. Blocks (one per log/back) split at separator gaps; portion
indices are fitted to the "consecutive descending" rule by majority vote, so a misread
cell can't corrupt a block.

**C. Confirm** (`pipeline.js LogStore`) — logs are tracked across sampled frames by
weight content (tolerating small portion-number shifts), and each `(log, portion, track)`
weight is only emitted after being read identically in **≥2 different frames**. Near-
duplicate logs get merged. Anything not confirmable is omitted or flagged — never
silently wrong.

Full rationale and rejected alternatives: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Real-time behaviour

The loop is **self-pacing**: a sample is taken, processed to completion, then the next
sample is scheduled (`interval − elapsed`, floor 250 ms). If a phone takes 8 s to process
with a 5 s interval, it simply samples every ~8 s — there is no backlog and no queue.

Correctness degrades gracefully with slower sampling: portions stay visible on the HMI
list for roughly 20–30 s (16-row list at ~1 portion/s across both tracks), so the 2-frame
confirmation holds for effective cadences up to ~10 s. Measured processing times:

| Environment | per sample |
|---|---|
| Desktop Chrome (headless, contended CPU) | 3–6 s |
| Modern Android (est., WASM+SIMD) | ~4–8 s |

If a device proves slow: use **▦ Mask** (smaller locate pass), pick the 5 s interval, or
see the geometry-caching optimisation noted in ARCHITECTURE.md § Future work.

## Validation

Scored against ground-truth CSVs (hand-verified by a prior analysis pass) for six ~10-min
line videos, using the log-alignment evaluator in [`reference/gt_eval.py`](reference/gt_eval.py):

| Engine | Video | Result |
|---|---|---|
| Python reference | T1_ControlB (186 portions, 12 logs) | **100%** — 0 wrong, 0 missing, 0 spurious (reproduced twice) |
| Python reference | T1_Control (426 portions, 34 logs) | 96.7% recovered, remaining errors traced to a since-fixed log-keying issue |
| **Browser engine (this app)** | T1_ControlB | **98.4%** — 183/186, **0 wrong, 0 spurious**; 3 misses were rows already scrolling off when the recording starts (cold-start artefact — doesn't occur when the app is started before slicing) |

The reliability bar throughout: *a value that is emitted must be right; anything doubtful
is dropped or flagged, never guessed.*

## Repository layout

```
index.html    app shell: UI, camera/video plumbing, sampling loop, CSV export, test hooks
engine.js     stage A+B: locate (columns/tilt) and read (rows/blocks/indices)
pipeline.js   pure logic: ink mask, connected components, GlyphBank, LogStore, fitting
sw.js         service worker — offline cache (bump CACHE to push updates to phones)
tess/         vendored tesseract.js + wasm cores + eng data (offline OCR detector)
reference/    Python reference implementation + ground-truth evaluator (dev docs inside)
```

The Python reference (`reference/read_video.py`) and the JS engine implement the same
algorithm and are kept in sync deliberately — improvements are proven against ground
truth in Python first, then ported.

## Development

- Static site: serve the folder over HTTPS (camera requires it) and open `index.html`.
- Update clients by bumping `CACHE` in `sw.js` — installed phones pick the new version
  up on their next online launch.
- In-page test hooks (DevTools): `__engineFrame(imageUrl)` → parsed blocks for one frame;
  `__engineImages(urls, title, target)` → run a frame sequence, returns the CSV.
- Evaluate any output against a gold CSV: `python reference/gt_eval.py pred.csv gold.csv -v`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
