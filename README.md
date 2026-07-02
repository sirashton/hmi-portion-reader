# HMI Portion Reader (MVP)

On-device web app that reads a slicer HMI screen through the phone camera and logs
portion weights to a CSV. **All processing is on-device** — no image or data ever leaves the phone.

## Use it
1. Open the app (HTTPS link) on the phone. First open needs internet for a few seconds to
   install the offline engine; after that it works with no internet.
2. Optionally tap the browser's **Add to Home Screen** to install it.
3. Type a **trial name** (this becomes the CSV filename).
4. Drag/resize the green box to frame the weight column(s). For two tracks, include both
   columns; the far-left index numbers can be left out.
5. Tap **Start**, point steadily at the screen (a fixed stand is best).
6. Tap **Stop** — the CSV downloads automatically. Columns: `index, elapsed_s, track1, track2, raw`.

## Notes / limitations (MVP)
- Logs top-of-list portion weights as they appear; no portion-index / loaf tracking yet.
- Best results with the phone mounted square to the HMI (reduces glare/skew).
- OCR: Tesseract.js (vendored under `tess/`, runs in-browser). Track 1/2 split by column position.

## Dev
- Static site — just serve the folder over HTTPS. `sw.js` caches the shell for offline use;
  bump `CACHE` in `sw.js` to force clients to update.
- `window.__ocrTest('img.jpg')` in the console runs OCR on an image for debugging.
