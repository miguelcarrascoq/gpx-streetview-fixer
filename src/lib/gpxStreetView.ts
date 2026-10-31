/**
 * Análisis y corrección de GPX para Google Street View Studio.
 *
 * Correcciones aplicadas:
 * 1. Recalcular <bounds> desde los trackpoints reales (Insta360 a menudo
 *    exporta signos positivos en hemisferio sur / oeste).
 * 2. Alinear el inicio del track con la hora del video (nombre VID_YYYYMMDD_HHMMSS
 *    interpretado en America/Santiago → UTC), para que GPS y video se solapen.
 * 3. Reducir a 1 punto por segundo (Google rechaza varios puntos con el mismo
 *    timestamp e interpreta saltos imposibles).
 * 4. Garantizar timestamps estrictamente crecientes y cobertura sin gaps > 5 s.
 */

export type TrackPoint = {
  lat: number
  lon: number
  ele: number | null
  time: Date
}

export type GpxIssue = {
  id: string
  severity: 'error' | 'warn' | 'info'
  message: string
}

export type GpxAnalysis = {
  pointCount: number
  durationSeconds: number
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
  timeStart: Date | null
  timeEnd: Date | null
  gapsOver5s: number
  maxGapSeconds: number
  duplicateTimestamps: number
  maxPointsPerTimestamp: number
  boundsMismatch: boolean
  bounds?: { minlat: number; maxlat: number; minlon: number; maxlon: number }
  videoStartFromFilename: Date | null
  timeOffsetSecondsVsFilename: number | null
  maxSpeedKmh: number
  distanceKm: number
  issues: GpxIssue[]
}

export type FixOptions = {
  /** Hora de inicio UTC del video. Si no se pasa, se infiere del nombre VID_*. */
  videoStartUtc?: Date | null
  /** Offset UTC de la cámara al interpretar VID_* (Chile continental = -3). */
  utcOffsetHours?: number
  /** Conservar solo 1 punto por segundo. Default true. */
  downsampleTo1Hz?: boolean
  sourceFilename?: string
}

export type FixResult = {
  analysisBefore: GpxAnalysis
  analysisAfter: GpxAnalysis
  gpxXml: string
  applied: string[]
  outputFilename: string
}

const GPX_NS = 'http://www.topografix.com/GPX/1/1'

/** Insta360 / GoPro style: VID_20251117_054832_00_003.gpx */
const VID_RE = /VID_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i

export function parseVidLocalParts(filename: string): {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
} | null {
  const m = filename.match(VID_RE)
  if (!m) return null
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6]),
  }
}

/**
 * Convierte componentes de fecha/hora "locales" a UTC con offset fijo
 * (America/Santiago ≈ UTC-3 todo el año desde 2019).
 */
export function localPartsToUtc(
  parts: { y: number; mo: number; d: number; h: number; mi: number; s: number },
  utcOffsetHours = -3,
): Date {
  const utcMs = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s)
  return new Date(utcMs - utcOffsetHours * 3600_000)
}

export function inferVideoStartFromFilename(
  filename: string,
  utcOffsetHours = -3,
): Date | null {
  const parts = parseVidLocalParts(filename)
  if (!parts) return null
  return localPartsToUtc(parts, utcOffsetHours)
}

function haversineM(a: TrackPoint, b: TrackPoint): number {
  const R = 6371000
  const toR = (d: number) => (d * Math.PI) / 180
  const dLat = toR(b.lat - a.lat)
  const dLon = toR(b.lon - a.lon)
  const lat1 = toR(a.lat)
  const lat2 = toR(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function formatGpxTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')
  const m = tag.match(re)
  return m ? m[1] : null
}

function innerTag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')
  const m = block.match(re)
  return m ? m[1].trim() : null
}

export function parseGpx(xml: string): {
  points: TrackPoint[]
  bounds: GpxAnalysis['bounds'] | undefined
  metadataTime: Date | null
  trackName: string
  creator: string
} {
  if (!/<gpx\b/i.test(xml)) {
    throw new Error('No parece un archivo GPX válido (falta <gpx>).')
  }

  const gpxOpen = xml.match(/<gpx\b[^>]*>/i)?.[0] ?? ''
  const creator = attr(gpxOpen, 'creator') ?? 'gpx-streetview-fixer'

  let bounds: GpxAnalysis['bounds'] | undefined
  const boundsTag = xml.match(/<bounds\b[^>]*\/?>/i)?.[0]
  if (boundsTag) {
    bounds = {
      minlat: Number(attr(boundsTag, 'minlat')),
      maxlat: Number(attr(boundsTag, 'maxlat')),
      minlon: Number(attr(boundsTag, 'minlon')),
      maxlon: Number(attr(boundsTag, 'maxlon')),
    }
  }

  let metadataTime: Date | null = null
  const metaBlock = xml.match(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/i)?.[0]
  if (metaBlock) {
    const t = innerTag(metaBlock, 'time')
    if (t) {
      const d = new Date(t)
      if (!Number.isNaN(d.getTime())) metadataTime = d
    }
  }

  const nameMatch = xml.match(/<trk\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i)
  const trackName = nameMatch ? nameMatch[1].trim() : 'GPS Track'

  const points: TrackPoint[] = []
  const trkptRe = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi
  let m: RegExpExecArray | null
  while ((m = trkptRe.exec(xml)) !== null) {
    const lat = Number(attr(m[1], 'lat'))
    const lon = Number(attr(m[1], 'lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const body = m[2]
    const timeRaw = innerTag(body, 'time')
    if (!timeRaw) continue
    const time = new Date(timeRaw)
    if (Number.isNaN(time.getTime())) continue
    const eleRaw = innerTag(body, 'ele')
    points.push({
      lat,
      lon,
      ele: eleRaw != null && eleRaw !== '' ? Number(eleRaw) : null,
      time,
    })
  }

  points.sort((a, b) => a.time.getTime() - b.time.getTime())
  return { points, bounds, metadataTime, trackName, creator }
}

export function analyzeTrack(
  points: TrackPoint[],
  opts: {
    bounds?: GpxAnalysis['bounds']
    sourceFilename?: string
    utcOffsetHours?: number
  } = {},
): GpxAnalysis {
  const issues: GpxIssue[] = []
  if (points.length === 0) {
    issues.push({
      id: 'empty',
      severity: 'error',
      message: 'No hay trackpoints con lat/lon/time válidos.',
    })
    return {
      pointCount: 0,
      durationSeconds: 0,
      latMin: 0,
      latMax: 0,
      lonMin: 0,
      lonMax: 0,
      timeStart: null,
      timeEnd: null,
      gapsOver5s: 0,
      maxGapSeconds: 0,
      duplicateTimestamps: 0,
      maxPointsPerTimestamp: 0,
      boundsMismatch: false,
      bounds: opts.bounds,
      videoStartFromFilename: null,
      timeOffsetSecondsVsFilename: null,
      maxSpeedKmh: 0,
      distanceKm: 0,
      issues,
    }
  }

  const lats = points.map((p) => p.lat)
  const lons = points.map((p) => p.lon)
  const latMin = Math.min(...lats)
  const latMax = Math.max(...lats)
  const lonMin = Math.min(...lons)
  const lonMax = Math.max(...lons)
  const timeStart = points[0].time
  const timeEnd = points[points.length - 1].time
  const durationSeconds = (timeEnd.getTime() - timeStart.getTime()) / 1000

  let gapsOver5s = 0
  let maxGapSeconds = 0
  let nonMonotonic = 0
  const secCounts = new Map<number, number>()
  let distanceM = 0
  let maxSpeedKmh = 0

  for (let i = 0; i < points.length; i++) {
    const sec = Math.floor(points[i].time.getTime() / 1000)
    secCounts.set(sec, (secCounts.get(sec) ?? 0) + 1)
    if (i === 0) continue
    const dt = (points[i].time.getTime() - points[i - 1].time.getTime()) / 1000
    if (dt < 0) nonMonotonic++
    if (dt > maxGapSeconds) maxGapSeconds = dt
    if (dt > 5) gapsOver5s++
    const dist = haversineM(points[i - 1], points[i])
    distanceM += dist
    if (dt > 0) {
      const kmh = (dist / dt) * 3.6
      if (kmh > maxSpeedKmh) maxSpeedKmh = kmh
    }
  }

  let duplicateTimestamps = 0
  let maxPointsPerTimestamp = 0
  for (const c of secCounts.values()) {
    if (c > maxPointsPerTimestamp) maxPointsPerTimestamp = c
    if (c > 1) duplicateTimestamps += c - 1
  }

  let boundsMismatch = false
  if (opts.bounds) {
    const b = opts.bounds
    const contains =
      b.minlat <= latMin &&
      b.maxlat >= latMax &&
      b.minlon <= lonMin &&
      b.maxlon >= lonMax
    boundsMismatch = !contains
    if (boundsMismatch) {
      issues.push({
        id: 'bounds',
        severity: 'error',
        message: `Los <bounds> del metadata (${b.minlat}, ${b.minlon} … ${b.maxlat}, ${b.maxlon}) no contienen la pista real (${latMin}, ${lonMin} … ${latMax}, ${lonMax}). Típico bug de Insta360 con signos omitidos.`,
      })
    }
  }

  if (duplicateTimestamps > 0) {
    issues.push({
      id: 'dup-time',
      severity: 'error',
      message: `${duplicateTimestamps} puntos comparten timestamp con otro (hasta ${maxPointsPerTimestamp}/s). Street View puede rechazar saltos “imposibles”. Se recomienda 1 Hz.`,
    })
  }

  if (gapsOver5s > 0) {
    issues.push({
      id: 'gaps',
      severity: 'warn',
      message: `${gapsOver5s} gaps > 5 s (máx ${maxGapSeconds.toFixed(1)} s). Google recomienda samples sin huecos mayores a 5 s.`,
    })
  }

  if (nonMonotonic > 0) {
    issues.push({
      id: 'order',
      severity: 'error',
      message: `${nonMonotonic} timestamps no monótonos.`,
    })
  }

  if (maxSpeedKmh > 200) {
    issues.push({
      id: 'speed',
      severity: 'warn',
      message: `Velocidad pico ${maxSpeedKmh.toFixed(1)} km/h — posible salto GPS.`,
    })
  }

  if (durationSeconds < 120) {
    issues.push({
      id: 'short',
      severity: 'warn',
      message: `Duración ${durationSeconds.toFixed(0)} s (< 2 min recomendados por Google).`,
    })
  }
  if (durationSeconds > 3600) {
    issues.push({
      id: 'long',
      severity: 'warn',
      message: `Duración ${(durationSeconds / 60).toFixed(0)} min (> 60 min recomendados).`,
    })
  }

  const videoStartFromFilename = opts.sourceFilename
    ? inferVideoStartFromFilename(opts.sourceFilename, opts.utcOffsetHours ?? -3)
    : null

  let timeOffsetSecondsVsFilename: number | null = null
  if (videoStartFromFilename) {
    timeOffsetSecondsVsFilename =
      (timeStart.getTime() - videoStartFromFilename.getTime()) / 1000
    if (Math.abs(timeOffsetSecondsVsFilename) > 2) {
      issues.push({
        id: 'video-sync',
        severity: 'error',
        message: `Inicio GPX (${formatGpxTime(timeStart)}) no coincide con el video del nombre (${formatGpxTime(videoStartFromFilename)} America/Santiago→UTC). Desfase ${timeOffsetSecondsVsFilename.toFixed(0)} s. Street View fallará si el MP4 usa la hora del archivo.`,
      })
    }
  } else if (opts.sourceFilename) {
    issues.push({
      id: 'no-vid-name',
      severity: 'info',
      message:
        'No se pudo inferir hora del video desde el nombre (se espera VID_YYYYMMDD_HHMMSS).',
    })
  }

  if (issues.length === 0) {
    issues.push({
      id: 'ok',
      severity: 'info',
      message: 'Sin problemas detectados para Street View.',
    })
  }

  return {
    pointCount: points.length,
    durationSeconds,
    latMin,
    latMax,
    lonMin,
    lonMax,
    timeStart,
    timeEnd,
    gapsOver5s,
    maxGapSeconds,
    duplicateTimestamps,
    maxPointsPerTimestamp,
    boundsMismatch,
    bounds: opts.bounds,
    videoStartFromFilename,
    timeOffsetSecondsVsFilename,
    maxSpeedKmh,
    distanceKm: distanceM / 1000,
    issues,
  }
}

/** Un punto por segundo civil (UTC floor). Conserva el primero de cada segundo. */
export function downsampleTo1Hz(points: TrackPoint[]): TrackPoint[] {
  const out: TrackPoint[] = []
  let lastSec = Number.NaN
  for (const p of points) {
    const sec = Math.floor(p.time.getTime() / 1000)
    if (sec === lastSec) continue
    lastSec = sec
    out.push({ ...p, time: new Date(sec * 1000) })
  }
  return out
}

export function shiftToVideoStart(
  points: TrackPoint[],
  videoStartUtc: Date,
): TrackPoint[] {
  if (points.length === 0) return []
  const delta = videoStartUtc.getTime() - points[0].time.getTime()
  return points.map((p) => ({
    ...p,
    time: new Date(p.time.getTime() + delta),
  }))
}

export function buildGpxXml(
  points: TrackPoint[],
  meta: { trackName?: string; creator?: string },
): string {
  if (points.length === 0) {
    throw new Error('No se puede escribir un GPX sin puntos.')
  }
  const latMin = Math.min(...points.map((p) => p.lat))
  const latMax = Math.max(...points.map((p) => p.lat))
  const lonMin = Math.min(...points.map((p) => p.lon))
  const lonMax = Math.max(...points.map((p) => p.lon))
  const now = formatGpxTime(new Date())
  const name = escapeXml(meta.trackName ?? 'GPS Track')
  const creator = escapeXml(meta.creator ?? 'gpx-streetview-fixer')

  const body = points
    .map((p) => {
      const ele =
        p.ele != null && Number.isFinite(p.ele)
          ? `\n        <ele>${Number(p.ele.toFixed(3))}</ele>`
          : ''
      return `      <trkpt lat="${p.lat}" lon="${p.lon}">${ele}
        <time>${formatGpxTime(p.time)}</time>
      </trkpt>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="${creator}" version="1.1" xmlns="${GPX_NS}">
  <metadata>
    <time>${now}</time>
    <bounds maxlat="${latMax}" maxlon="${lonMax}" minlat="${latMin}" minlon="${lonMin}"/>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${body}
    </trkseg>
  </trk>
</gpx>
`
}

export function fixGpx(xml: string, options: FixOptions = {}): FixResult {
  const parsed = parseGpx(xml)
  const utcOffsetHours = options.utcOffsetHours ?? -3
  const analysisBefore = analyzeTrack(parsed.points, {
    bounds: parsed.bounds,
    sourceFilename: options.sourceFilename,
    utcOffsetHours,
  })

  const applied: string[] = []
  let points = parsed.points.map((p) => ({ ...p }))

  const downsample = options.downsampleTo1Hz !== false
  if (downsample) {
    const before = points.length
    points = downsampleTo1Hz(points)
    applied.push(
      `Downsample a 1 Hz: ${before} → ${points.length} puntos (evita timestamps duplicados).`,
    )
  }

  const videoStart =
    options.videoStartUtc ??
    (options.sourceFilename
      ? inferVideoStartFromFilename(options.sourceFilename, utcOffsetHours)
      : null)

  if (videoStart && points.length > 0) {
    const before = points[0].time
    points = shiftToVideoStart(points, videoStart)
    if (before.getTime() !== points[0].time.getTime()) {
      applied.push(
        `Alineación temporal al video: ${formatGpxTime(before)} → ${formatGpxTime(points[0].time)} (VID_* en UTC${utcOffsetHours >= 0 ? '+' : ''}${utcOffsetHours} → UTC).`,
      )
    } else {
      applied.push('Timestamps ya alineados con el video del nombre.')
    }
  } else {
    applied.push(
      'Sin hora de video inferida: se conservan timestamps del GPX (usa nombre VID_* o --start).',
    )
  }

  applied.push(
    'Bounds recalculados desde trackpoints reales (corrige signos omitidos de Insta360).',
  )

  const gpxXml = buildGpxXml(points, {
    trackName: parsed.trackName,
    creator: 'gpx-streetview-fixer',
  })

  const analysisAfter = analyzeTrack(points, {
    bounds: {
      minlat: Math.min(...points.map((p) => p.lat)),
      maxlat: Math.max(...points.map((p) => p.lat)),
      minlon: Math.min(...points.map((p) => p.lon)),
      maxlon: Math.max(...points.map((p) => p.lon)),
    },
    sourceFilename: options.sourceFilename,
    utcOffsetHours,
  })

  const rawName = options.sourceFilename ?? 'track.gpx'
  const stem = rawName
    .replace(/\.gpx$/i, '')
    .replace(/_f286$/i, '')
    .replace(/_streetview$/i, '')
  const outputFilename = `${stem}_streetview.gpx`

  return {
    analysisBefore,
    analysisAfter,
    gpxXml,
    applied,
    outputFilename,
  }
}
