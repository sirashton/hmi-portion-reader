# HMI Portion Reader (v2 — staged engine)

On-device web app that reads a slicer HMI's portion list through the phone camera (or from a
recorded video) and logs **log number, portion number and weight per track** to a CSV.
**All processing is on-device** — no image or data ever leaves the phone; works offline after
the first load.

## How it reads (three stages)
1. **Locate** — OCR finds the numeric column structure (no manual framing needed); tilt is
   estimated from row baselines and corrected automatically.
2. **Read** — a second OCR pass on an upscaled crop of just the list; digits are recognised by
   a **self-calibrating glyph matcher** trained on the fly from the HMI's own font (weights AND
   the portion-index column); rows/blocks come from ink analysis, so sloppy OCR boxes don't matter.
3. **Confirm** — each (log, portion, track) weight must be seen identically in **≥2 sampled
   frames** before it's logged; logs are tracked across frames by weight content with
   shift-tolerant matching, and near-duplicate logs are merged.

## Use it
1. Open the app (HTTPS link). First open needs internet briefly to install the offline engine;
   after that it works with no internet. **Add to Home Screen** to install.
2. Type a **Trial** name (becomes the CSV filename + Video title column), the **Target g**
   for the product, and pick a sampling interval (3 s default).
3. Point the phone at the HMI — a fixed mount, square to the screen, works best. Or tap
   **📁 Video** to process a recorded clip instead.
4. Optional: **▦ Mask** limits reading to a drawn box (useful if other numbers are in view).
5. **Start**. Confirmed portions appear in the table as they're verified across frames
   (`•` marks heel/end portions, red = flagged unusual weight).
6. **Stop** (or let a video finish) — downloads `<trial>_portion_weights.csv` with schema:
   `Video title, Track, Log number, Portion number, Target Weight (g), Weight (g), Heel/End, Notes`.

## Accuracy
Validated against ground-truth CSVs for six line videos (validated Python reference: 100% on
the reference video — 186/186 portions, 0 wrong, 0 spurious). The browser engine is the same
algorithm; unusual weights are flagged in Notes rather than silently dropped.

## Dev
- Static site — serve the folder over HTTPS. `sw.js` caches for offline; bump `CACHE` to update clients.
- `pipeline.js` (pure logic) + `engine.js` (stage A/B) mirror `../pipeline/read_video.py`
  (Python reference used for ground-truth evaluation). Keep them in sync.
- Test hooks: `__engineFrame(url)` reads one image; `__engineImages(urls, title, target)` runs
  a whole frame sequence and returns the CSV.
