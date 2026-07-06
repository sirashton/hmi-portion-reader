# Changelog

## v2.3 — 2026-07-06 · live analysis
- **📊 Analysis view**: real-time portion CV explained by portion position — weight-vs-position
  scatter (% of target), CV by position, and CV-contribution bars, following the
  PortionTrialViz conventions (pos/neg indexing with tail-3 slots + MID bucket, light-last
  stripping, extreme-portion flagging/exclusion).
- **A/B attribution**: the live capture is a trial (default Group A); previous trial CSVs can
  be imported and assigned A/B/off — all charts and KPIs compare the groups live, enabling
  real-time A/B setting trials against a reference run. (SW v8)

## v2.2 — 2026-07-06 · live visual confirmation
- Green **locate overlay** drawn on the feed around the identified list (column guides,
  greys out when stale) — tracks pan/zoom.
- **HMI mirror** panel beside the feed: what the reader currently sees, formatted like the
  HMI list itself (blocks, separators, # | T1 | T2); green = confirmed across frames,
  grey = awaiting confirmation.
- **Frame archive**: every sampled frame stored (toggleable) and exportable as a ZIP
  (dependency-free writer, verified CRC-valid) for later re-evaluation of any trial. (SW v7)

## v2.1 — 2026-07-06
- Screen wake-lock while a trial is running (phone no longer sleeps mid-capture).
- Python reference implementation + ground-truth evaluator added under `reference/`.
- Full documentation set: README, ARCHITECTURE, CHANGELOG, LICENSE.
- (SW cache v6)

## v2.0 — 2026-07-06 · staged engine
- Auto-locate: finds the weight columns from the numeric structure (no manual framing);
  tilt estimated and corrected automatically. Manual box demoted to an optional Mask.
- Self-calibrating glyph reader: digit templates harvested from the HMI's own font each
  frame; weights AND the portion-index column read by template matching (OCR = detector only).
- Full log/portion tracking: blocks per log, consecutive-descending index fitting,
  shift-tolerant log matching, ≥2-frame confirmation, duplicate-log merging.
- CSV now in the analysis schema:
  `Video title, Track, Log number, Portion number, Target Weight (g), Weight (g), Heel/End, Notes`
  with heel/end marking and unusual-weight flagging.
- Validation vs ground truth (T1_ControlB): 183/186 recovered, 0 wrong, 0 spurious
  (Python reference: 186/186). (SW cache v5)

## v1.2 — 2026-07-02
- ROI expressed in source-video pixels with X/Y/W/H inputs → repeatable capture windows;
  video fills the viewport; pan/zoom is a pure viewing aid. (SW v4)

## v1.1 — 2026-07-02
- Video-file upload as an input source alongside the live camera. (SW v2)
- Pan/zoom + aspect-preserving video view. (SW v3)

## v1.0 — 2026-07-02 · MVP
- Offline PWA: live camera, manual ROI, tesseract.js reading of the top list row,
  Start/Stop, named CSV export. Vendored OCR assets + service worker (SW v1).
