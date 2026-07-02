# HMI Portion Reader (MVP)

On-device web app that reads a slicer HMI screen through the phone camera and logs
portion weights to a CSV. **All processing is on-device** — no image or data ever leaves the phone.

## Use it
1. Open the app (HTTPS link) on the phone. First open needs internet for a few seconds to
   install the offline engine; after that it works with no internet.
2. Optionally tap the browser's **Add to Home Screen** to install it.
3. Choose a **source**: the live camera (default), or tap **📁 Video** to load a recorded
   clip and process it instead. Tap **⟲ Camera** to go back to the live camera.
4. Type a **trial name** (this becomes the CSV filename).
5. **Pan/zoom** the view (pinch, drag the background, or the −/Fit/+ buttons) to enlarge the
   number list, then drag/resize the green box to frame the weight column(s). For two tracks,
   include both columns; the far-left index numbers can be left out. Video fills the viewport
   and keeps its aspect ratio (no stretch).
   - **Repeatable trials:** the box position is shown in **Box (px)** as X/Y/W/H in *video-pixel*
     coordinates. Note them down and re-type them next time to reproduce the exact capture window.
     The box is anchored to the video, so zooming/panning to position it never changes what's
     captured. (Coordinates are per video resolution — the same numbers reproduce on clips of the
     same size.)
6. Tap **Start** — for the camera, point steadily at the screen (a fixed stand is best);
   for a video, it plays and reads automatically, stopping at the end.
7. Tap **Stop** (or let a video finish) — the CSV downloads automatically.
   Columns: `index, elapsed_s, track1, track2, raw`. For a video, `elapsed_s` is the time
   within the clip.

## Notes / limitations (MVP)
- Logs top-of-list portion weights as they appear; no portion-index / loaf tracking yet.
- Best results with the phone mounted square to the HMI (reduces glare/skew).
- OCR: Tesseract.js (vendored under `tess/`, runs in-browser). Track 1/2 split by column position.

## Dev
- Static site — just serve the folder over HTTPS. `sw.js` caches the shell for offline use;
  bump `CACHE` in `sw.js` to force clients to update.
- `window.__ocrTest('img.jpg')` in the console runs OCR on an image for debugging.
