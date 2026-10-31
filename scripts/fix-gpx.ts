#!/usr/bin/env npx tsx
/**
 * CLI: analyze and fix GPX for Google Street View.
 *
 * Usage:
 *   npm run fix -- path/to/file.gpx
 *   npm run fix -- path/to/file.gpx --out output.gpx
 *   npm run analyze -- path/to/file.gpx
 *   npm run fix -- file.gpx --start 2025-11-17T08:48:32Z
 *   npm run fix -- file.gpx --offset -3
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeTrack,
  fixGpx,
  formatGpxTime,
  parseGpx,
} from '../src/lib/gpxStreetView.ts'

function printHelp(): void {
  console.log(`Usage:
  npm run fix -- <file.gpx> [options]
  npm run analyze -- <file.gpx>

Options:
  --out <path>          Output file (default: <name>_streetview.gpx)
  --start <ISO-UTC>     MP4 creation_time in UTC (ffprobe format.tags.creation_time)
  --keep-gpx            Keep Insta360 GPX timestamps (do not shift to VID_*)
  --offset <hours>      Camera offset when reading VID_* (default: -3, Chile)
  --keep-hz             Do not downsample to 1 point/second
  --analyze-only        Report only, do not write a file
  -h, --help            Show this help

Street View compares GPS times to the MP4 creation_time, which often differs
from the VID_* filename after a Studio re-export. Prefer --start from ffprobe.

Recommended flow (Insta360 → Street View Studio):
  1. Export the GPX from Insta360 Studio (same clip as the 360 MP4).
  2. npm run fix -- ./clip.gpx --start <MP4-creation_time-UTC>
     (or --keep-gpx when the GPX already matches the MP4)
  3. Upload the MP4 + the *_streetview.gpx at https://streetviewstudio.maps.google.com/
`)
}

function parseArgs(argv: string[]) {
  const args = [...argv]
  const opts: {
    file?: string
    out?: string
    start?: string
    offset: number
    keepHz: boolean
    keepGpx: boolean
    analyzeOnly: boolean
    help: boolean
  } = {
    offset: -3,
    keepHz: false,
    keepGpx: false,
    analyzeOnly: false,
    help: false,
  }

  while (args.length) {
    const a = args.shift()!
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '--out') opts.out = args.shift()
    else if (a === '--start') opts.start = args.shift()
    else if (a === '--offset') opts.offset = Number(args.shift())
    else if (a === '--keep-hz') opts.keepHz = true
    else if (a === '--keep-gpx') opts.keepGpx = true
    else if (a === '--analyze-only') opts.analyzeOnly = true
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`)
      opts.help = true
    } else opts.file = a
  }
  return opts
}

function printAnalysis(title: string, a: ReturnType<typeof analyzeTrack>): void {
  console.log(`\n=== ${title} ===`)
  console.log(`Points: ${a.pointCount}`)
  console.log(
    `Duration: ${a.durationSeconds.toFixed(0)} s | Distance: ${a.distanceKm.toFixed(3)} km | Max speed: ${a.maxSpeedKmh.toFixed(1)} km/h`,
  )
  if (a.timeStart && a.timeEnd) {
    console.log(`Time: ${formatGpxTime(a.timeStart)} → ${formatGpxTime(a.timeEnd)}`)
  }
  console.log(
    `Bbox: lat [${a.latMin}, ${a.latMax}] lon [${a.lonMin}, ${a.lonMax}]`,
  )
  console.log(
    `Duplicate seconds: ${a.duplicateTimestamps} (max ${a.maxPointsPerTimestamp}/s) | Gaps >5s: ${a.gapsOver5s}`,
  )
  if (a.videoStartFromFilename) {
    console.log(
      `Video (from filename): ${formatGpxTime(a.videoStartFromFilename)} | offset: ${a.timeOffsetSecondsVsFilename?.toFixed(0)} s`,
    )
  }
  console.log('Findings:')
  for (const issue of a.issues) {
    const tag = issue.severity.toUpperCase().padEnd(5)
    console.log(`  [${tag}] ${issue.message}`)
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.file) {
    printHelp()
    process.exit(opts.help ? 0 : 1)
  }

  const abs = path.resolve(opts.file)
  const xml = await readFile(abs, 'utf8')
  const filename = path.basename(abs)

  if (opts.analyzeOnly) {
    const parsed = parseGpx(xml)
    const analysis = analyzeTrack(parsed.points, {
      bounds: parsed.bounds,
      sourceFilename: filename,
      utcOffsetHours: opts.offset,
    })
    printAnalysis(`Analysis: ${filename}`, analysis)
    const hasError = analysis.issues.some((i) => i.severity === 'error')
    process.exit(hasError ? 2 : 0)
  }

  const videoStartUtc = opts.start ? new Date(opts.start) : null
  if (opts.start && Number.isNaN(videoStartUtc!.getTime())) {
    console.error(`Invalid --start: ${opts.start}`)
    process.exit(1)
  }
  if (opts.start && opts.keepGpx) {
    console.error('Use either --start or --keep-gpx, not both.')
    process.exit(1)
  }

  const result = fixGpx(xml, {
    sourceFilename: filename,
    utcOffsetHours: opts.offset,
    downsampleTo1Hz: !opts.keepHz,
    videoStartUtc,
    videoStartLabel: opts.start ? 'MP4 creation_time' : null,
    syncSource: opts.start ? 'mp4' : opts.keepGpx ? 'gpx' : 'filename',
  })

  printAnalysis('Before', result.analysisBefore)
  console.log('\nFixes applied:')
  for (const line of result.applied) console.log(`  • ${line}`)
  printAnalysis('After', result.analysisAfter)

  const outPath = path.resolve(
    opts.out ?? path.join(path.dirname(abs), result.outputFilename),
  )
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, result.gpxXml, 'utf8')
  console.log(`\nWrote: ${outPath}`)
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

// silence unused in some runners
void isMain
