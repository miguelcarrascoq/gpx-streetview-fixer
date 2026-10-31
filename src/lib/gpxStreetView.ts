/**
 * Analyze and fix GPX for Google Street View Studio.
 *
 * Fixes applied:
 * 1. Recalculate <bounds> from real trackpoints (Insta360 often
 *    exports positive signs in southern / western hemisphere).
 * 2. Align track start with video time (VID_YYYYMMDD_HHMMSS name
 *    interpreted in America/Santiago → UTC), so GPS and video overlap.
 * 3. Downsample to 1 point per second (Google rejects multiple points with
 *    the same timestamp and interprets impossible jumps).
 * 4. Ensure strictly increasing timestamps and coverage without gaps > 5 s.
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
  /** Video start time in UTC. If omitted, inferred from VID_* filename. */
  videoStartUtc?: Date | null
  /** Camera UTC offset when interpreting VID_* (continental Chile = -3). */
  utcOffsetHours?: number
  /** Keep only 1 point per second. Default true. */
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

/** Hours ahead of UTC, e.g. -3 → `UTC-3`, 5.5 → `UTC+5:30`. */
export function formatUtcOffsetHours(hours: number): string {
  if (!Number.isFinite(hours)) return 'UTC'
  const sign = hours < 0 ? '-' : '+'
  const totalMinutes = Math.round(Math.abs(hours) * 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (m === 0) return `UTC${sign}${h}`
  return `UTC${sign}${h}:${String(m).padStart(2, '0')}`
}

/**
 * Convert local date/time components to UTC.
 * `utcOffsetHours` is hours ahead of UTC (Chile summer −3, Chile winter −4).
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
    throw new Error('Does not look like a valid GPX file (missing <gpx>).')
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
      message: 'No trackpoints with valid lat/lon/time.',
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
        message: `Metadata <bounds> (${b.minlat}, ${b.minlon} … ${b.maxlat}, ${b.maxlon}) do not contain the real track (${latMin}, ${lonMin} … ${latMax}, ${lonMax}). Typical Insta360 bug with omitted signs.`,
      })
    }
  }

  if (duplicateTimestamps > 0) {
    issues.push({
      id: 'dup-time',
      severity: 'error',
      message: `${duplicateTimestamps} points share a timestamp with another (up to ${maxPointsPerTimestamp}/s). Street View may reject “impossible” jumps. 1 Hz recommended.`,
    })
  }

  if (gapsOver5s > 0) {
    issues.push({
      id: 'gaps',
      severity: 'warn',
      message: `${gapsOver5s} gaps > 5 s (max ${maxGapSeconds.toFixed(1)} s). Google recommends samples without gaps larger than 5 s.`,
    })
  }

  if (nonMonotonic > 0) {
    issues.push({
      id: 'order',
      severity: 'error',
      message: `${nonMonotonic} non-monotonic timestamps.`,
    })
  }

  if (maxSpeedKmh > 200) {
    issues.push({
      id: 'speed',
      severity: 'warn',
      message: `Peak speed ${maxSpeedKmh.toFixed(1)} km/h — possible GPS jump.`,
    })
  }

  if (durationSeconds < 120) {
    issues.push({
      id: 'short',
      severity: 'warn',
      message: `Duration ${durationSeconds.toFixed(0)} s (< 2 min recommended by Google).`,
    })
  }
  if (durationSeconds > 3600) {
    issues.push({
      id: 'long',
      severity: 'warn',
      message: `Duration ${(durationSeconds / 60).toFixed(0)} min (> 60 min recommended).`,
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
        message: `GPX start (${formatGpxTime(timeStart)}) does not match video from filename (${formatGpxTime(videoStartFromFilename)}, ${formatUtcOffsetHours(opts.utcOffsetHours ?? -3)}). Offset ${timeOffsetSecondsVsFilename.toFixed(0)} s. Street View will fail if the MP4 uses the file time.`,
      })
    }
  } else if (opts.sourceFilename) {
    issues.push({
      id: 'no-vid-name',
      severity: 'info',
      message:
        'Could not infer video time from filename (expected VID_YYYYMMDD_HHMMSS).',
    })
  }

  if (issues.length === 0) {
    issues.push({
      id: 'ok',
      severity: 'info',
      message: 'No Street View issues detected.',
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

/** One point per civil second (UTC floor). Keeps the first of each second. */
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
    throw new Error('Cannot write a GPX with no points.')
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
      `Downsample to 1 Hz: ${before} → ${points.length} points (avoids duplicate timestamps).`,
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
        `Time aligned to video: ${formatGpxTime(before)} → ${formatGpxTime(points[0].time)} (VID_* at ${formatUtcOffsetHours(utcOffsetHours)} → UTC).`,
      )
    } else {
      applied.push('Timestamps already aligned with video from filename.')
    }
  } else {
    applied.push(
      'No video time inferred: keeping GPX timestamps (use VID_* name or --start).',
    )
  }

  applied.push(
    'Bounds recalculated from real trackpoints (fixes omitted Insta360 signs).',
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
