#!/usr/bin/env npx tsx
/**
 * CLI: analiza y corrige GPX para Google Street View.
 *
 * Uso:
 *   npm run fix -- ruta/al/archivo.gpx
 *   npm run fix -- ruta/al/archivo.gpx --out salida.gpx
 *   npm run analyze -- ruta/al/archivo.gpx
 *   npm run fix -- archivo.gpx --start 2025-11-17T08:48:32Z
 *   npm run fix -- archivo.gpx --offset -3
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
  console.log(`Uso:
  npm run fix -- <archivo.gpx> [opciones]
  npm run analyze -- <archivo.gpx>

Opciones:
  --out <ruta>          Archivo de salida (default: <nombre>_streetview.gpx)
  --start <ISO-UTC>     Inicio del video en UTC (ej. 2025-11-17T08:48:32Z)
  --offset <horas>      Offset de la cámara al leer VID_* (default: -3, Chile)
  --keep-hz             No reducir a 1 punto/segundo
  --analyze-only        Solo informe, no escribe archivo
  -h, --help            Esta ayuda

Flujo recomendado (Insta360 → Street View Studio):
  1. Exporta el GPX desde Insta360 Studio (mismo clip que el MP4 360).
  2. Conserva el prefijo VID_YYYYMMDD_HHMMSS en el nombre del .gpx.
  3. npm run fix -- ./mis-clips/VID_....gpx
  4. Sube el MP4 + el *_streetview.gpx en https://streetviewstudio.maps.google.com/
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
    analyzeOnly: boolean
    help: boolean
  } = { offset: -3, keepHz: false, analyzeOnly: false, help: false }

  while (args.length) {
    const a = args.shift()!
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '--out') opts.out = args.shift()
    else if (a === '--start') opts.start = args.shift()
    else if (a === '--offset') opts.offset = Number(args.shift())
    else if (a === '--keep-hz') opts.keepHz = true
    else if (a === '--analyze-only') opts.analyzeOnly = true
    else if (a.startsWith('-')) {
      console.error(`Opción desconocida: ${a}`)
      opts.help = true
    } else opts.file = a
  }
  return opts
}

function printAnalysis(title: string, a: ReturnType<typeof analyzeTrack>): void {
  console.log(`\n=== ${title} ===`)
  console.log(`Puntos: ${a.pointCount}`)
  console.log(
    `Duración: ${a.durationSeconds.toFixed(0)} s | Distancia: ${a.distanceKm.toFixed(3)} km | Vmax: ${a.maxSpeedKmh.toFixed(1)} km/h`,
  )
  if (a.timeStart && a.timeEnd) {
    console.log(`Tiempo: ${formatGpxTime(a.timeStart)} → ${formatGpxTime(a.timeEnd)}`)
  }
  console.log(
    `Bbox: lat [${a.latMin}, ${a.latMax}] lon [${a.lonMin}, ${a.lonMax}]`,
  )
  console.log(
    `Duplicados de segundo: ${a.duplicateTimestamps} (máx ${a.maxPointsPerTimestamp}/s) | Gaps >5s: ${a.gapsOver5s}`,
  )
  if (a.videoStartFromFilename) {
    console.log(
      `Video (desde nombre): ${formatGpxTime(a.videoStartFromFilename)} | desfase: ${a.timeOffsetSecondsVsFilename?.toFixed(0)} s`,
    )
  }
  console.log('Hallazgos:')
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
    printAnalysis(`Análisis: ${filename}`, analysis)
    const hasError = analysis.issues.some((i) => i.severity === 'error')
    process.exit(hasError ? 2 : 0)
  }

  const videoStartUtc = opts.start ? new Date(opts.start) : null
  if (opts.start && Number.isNaN(videoStartUtc!.getTime())) {
    console.error(`--start inválido: ${opts.start}`)
    process.exit(1)
  }

  const result = fixGpx(xml, {
    sourceFilename: filename,
    utcOffsetHours: opts.offset,
    downsampleTo1Hz: !opts.keepHz,
    videoStartUtc,
  })

  printAnalysis('Antes', result.analysisBefore)
  console.log('\nCorrecciones aplicadas:')
  for (const line of result.applied) console.log(`  • ${line}`)
  printAnalysis('Después', result.analysisAfter)

  const outPath = path.resolve(
    opts.out ?? path.join(path.dirname(abs), result.outputFilename),
  )
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, result.gpxXml, 'utf8')
  console.log(`\nEscrito: ${outPath}`)
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
