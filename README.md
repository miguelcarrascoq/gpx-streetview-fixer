# GPX Street View Fixer

Tool to **analyze and fix** `.gpx` files (e.g. exported from Insta360 Studio) before uploading them to [Google Street View Studio](https://streetviewstudio.maps.google.com/) together with the 360 video.

## What it fixes

1. **Bounds with wrong signs** — Insta360 sometimes writes positive lat/lon in `<bounds>` while trackpoints are in the southern/western hemisphere (Chile, etc.).
2. **Sync with the video** — If the file is named `VID_YYYYMMDD_HHMMSS_…`, it aligns the GPX start to that local time (default **America/Santiago = UTC−3**). Street View requires the GPS range to overlap the MP4 range.
3. **1 point per second** — Multiple points with the same timestamp make Google interpret impossible jumps and reject the sequence.

## Quick start (CLI) — other files

```bash
npm install

# Report only (does not write a file)
npm run analyze -- ./uploads/VID_20251117_054832_00_003.gpx

# Fix → writes *_streetview.gpx next to the original
npm run fix -- ./uploads/VID_20251117_054832_00_003.gpx

# Explicit output
npm run fix -- ./my-clip.gpx --out ./out/my-clip_streetview.gpx

# If the MP4 time does not match the VID_* name
npm run fix -- ./my-clip.gpx --start 2025-11-17T08:48:32Z

# Different zone (camera offset relative to UTC)
npm run fix -- ./my-clip.gpx --offset -3
```

### Checklist for each new clip

1. Export the **360 MP4** and the **GPX** from the same clip.
2. Keep the `VID_YYYYMMDD_HHMMSS` prefix on the `.gpx` (camera local time).
3. Run `npm run fix -- path/to/file.gpx`.
4. Check that the **After** report has no errors.
5. In Street View Studio: Upload the video → **More → Upload GPX file** → choose the `*_streetview.gpx`.

## Web app

**Live:** [miguelcarrascoq.github.io/gpx-streetview-fixer](https://miguelcarrascoq.github.io/gpx-streetview-fixer/)

```bash
npm run dev
```

Open http://127.0.0.1:43123 — drop a `.gpx`, review the report, and download the fixed file.

Pushes to `main` build and publish the site with GitHub Actions (GitHub Pages).

## Project sample files

| File | Description |
|------|-------------|
| [`uploads/VID_20251117_054832_00_003_f286.gpx`](uploads/VID_20251117_054832_00_003_f286.gpx) | Original Insta360 (bad bounds, ~10 Hz, shifted dates) |
| [`output/VID_20251117_054832_00_003_streetview.gpx`](output/VID_20251117_054832_00_003_streetview.gpx) | Fixed file ready for Street View |

### Fixes applied to this clip

- Bounds recalculated to **negative** lat/lon (Temuco, Chile area).
- Start aligned to `VID_20251117_054832` → `2025-11-17T08:48:32Z` (05:48:32 local UTC−3).
- Reduced from ~17,147 points to ~1 point/s (~29 min of track).

If Street View says GPS and video do not overlap, read the real MP4 time (Exif / Studio) and re-run with `--start <ISO-UTC>`.
