# Portion Reader — Python reference pipeline

Local development/validation tooling for the HMI Portion Reader PWA (`../pwa/`).
Not deployed anywhere — the phone app is the deliverable; this folder is where the
reading algorithm is developed and scored against ground truth.

## Files
- **`read_video.py`** — the staged reference reader:
  1. *locate*: full-frame OCR (RapidOCR/PP-OCR, ONNX, offline) → Track 1/2 headers → derotate + crop
  2. *read*: upscaled crop OCR → rows; self-calibrating **glyph bank** (digit templates harvested
     from the weight tokens each frame) reads the portion-index column; blocks split at
     separator gaps; consecutive-descending index fit per block
  3. *merge*: `LogStore` tracks logs across frames by weight content (pn-shift-tolerant),
     each (log, portion, track) needs ≥2 confirming frames; near-duplicate logs merged at emit
  - Sampling: uniform step (default 2 s) + densified first 8 s / last 12 s so boundary
    portions still get 2-frame confirmation.
  - Usage: `python read_video.py <video.mp4> --target 667 [--step 2] [--out pred.csv] [--debug]`
- **`gt_eval.py`** — scores a produced CSV against a gold `*_portion_weights.csv`
  (log alignment by weight content, so numbering offsets don't penalise).
  Usage: `python gt_eval.py pred.csv gold.csv [-v]`
- **`run_all.py`** — runs + scores all six gold videos in `../../Portion Trial Vids/`.

## Ground truth
Six video+CSV pairs in `../../Portion Trial Vids/` (made by a previous agent, treated as gold).
CSV schema: `Video title, Track, Log number, Portion number, Target Weight (g), Weight (g), Heel/End, Notes`.

## Results (2026-07-06)
- `T1_ControlB`: **100%** — 186/186 recovered, 0 wrong, 0 missing, 0 spurious, 12/12 logs.
- `T1_Control`: 96.7%+ (remaining errors were pn-baseline shifts, fixed by the new-log
  confidence gate after that run; re-run pending).
- The JS port (`../pwa/pipeline.js` + `engine.js`) mirrors this file function-for-function;
  keep them in sync. JS uses tesseract.js as detector only — glyph bank does the recognition.

## Requirements
`pip install rapidocr-onnxruntime opencv-python numpy`
