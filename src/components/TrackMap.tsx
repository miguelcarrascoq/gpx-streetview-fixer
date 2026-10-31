import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GpxAnalysis } from '../lib/gpxStreetView'

const TRACK_COLOR = '#2ee6a6'
const OVERSAMPLE_COLOR = '#ffd24a'
const PROBLEM_COLOR = '#ff3b3b'
const LINE_CASING = '#0a1210'
/** Sparse dup markers above this → treat as dense oversample. */
const DUP_MARKER_LIMIT = 400
/** Fraction of track duration seconds with dup-time → dense. */
const DUP_DENSE_RATIO = 0.4
/** Max vertices kept for the base track polyline. */
const TRACK_DISPLAY_MAX = 4000

/** Dark casing + bright stroke so lines stay readable on Map/Topo/Satellite. */
function addCasedPolyline(
  layer: L.LayerGroup,
  latlngs: L.LatLngExpression[],
  opts: {
    color: string
    weight: number
    opacity?: number
    dashArray?: string
  },
) {
  const casing = Math.max(opts.weight + 3, Math.round(opts.weight * 1.7))
  L.polyline(latlngs, {
    color: LINE_CASING,
    weight: casing,
    opacity: 0.92,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: opts.dashArray,
  }).addTo(layer)
  L.polyline(latlngs, {
    color: opts.color,
    weight: opts.weight,
    opacity: opts.opacity ?? 1,
    lineCap: 'round',
    lineJoin: 'round',
    dashArray: opts.dashArray,
  }).addTo(layer)
}

/** High-contrast red anomaly marker (halo + fill). */
function addAnomalyMarker(
  layer: L.LayerGroup,
  latlng: L.LatLngExpression,
  radius = 8,
) {
  L.circleMarker(latlng, {
    radius: radius + 3,
    color: '#ffffff',
    fillColor: '#ffffff',
    fillOpacity: 0.95,
    weight: 0,
    opacity: 1,
  }).addTo(layer)
  L.circleMarker(latlng, {
    radius,
    color: LINE_CASING,
    fillColor: PROBLEM_COLOR,
    fillOpacity: 1,
    weight: 2,
    opacity: 1,
  }).addTo(layer)
}

type BasemapId = 'map' | 'topo' | 'satellite'

type TrackMapProps = {
  analysis: GpxAnalysis
}

export type MapProblemSummary = {
  gapCount: number
  speedCount: number
  dupCount: number
  denseOversample: boolean
  /** Short status line for the chip under the map. */
  label: string
}

export function summarizeMapProblems(analysis: GpxAnalysis): MapProblemSummary {
  let gapCount = 0
  let speedCount = 0
  let dupCount = 0
  for (const p of analysis.problems) {
    if (p.kind === 'gap') gapCount++
    else if (p.kind === 'speed') speedCount++
    else if (p.kind === 'dup-time') dupCount++
  }

  const durationSec = Math.max(1, Math.round(analysis.durationSeconds))
  const denseOversample =
    dupCount > DUP_MARKER_LIMIT || dupCount / durationSec >= DUP_DENSE_RATIO

  if (gapCount + speedCount + dupCount === 0) {
    return {
      gapCount,
      speedCount,
      dupCount,
      denseOversample: false,
      label: 'No map issues',
    }
  }

  const parts: string[] = []
  if (denseOversample) {
    parts.push(
      `Oversampled along the track (${dupCount.toLocaleString('en-US')} duplicate seconds)`,
    )
  } else if (dupCount > 0) {
    parts.push(`${dupCount.toLocaleString('en-US')} duplicate-time spots`)
  }
  if (gapCount > 0) parts.push(`${gapCount} gap${gapCount === 1 ? '' : 's'}`)
  if (speedCount > 0) {
    parts.push(`${speedCount} speed jump${speedCount === 1 ? '' : 's'}`)
  }

  return {
    gapCount,
    speedCount,
    dupCount,
    denseOversample,
    label: parts.join(' · '),
  }
}

function downsampleTrack(
  track: { lat: number; lon: number }[],
  maxPoints: number,
): L.LatLngExpression[] {
  if (track.length <= maxPoints) {
    return track.map((p) => [p.lat, p.lon])
  }
  const step = Math.ceil(track.length / maxPoints)
  const out: L.LatLngExpression[] = []
  for (let i = 0; i < track.length; i += step) {
    out.push([track[i].lat, track[i].lon])
  }
  const last = track[track.length - 1]
  const prev = out[out.length - 1]
  if (
    !prev ||
    (Array.isArray(prev) && (prev[0] !== last.lat || prev[1] !== last.lon))
  ) {
    out.push([last.lat, last.lon])
  }
  return out
}

function paintAnalysis(
  trackLayer: L.LayerGroup,
  problemsLayer: L.LayerGroup,
  analysis: GpxAnalysis,
  summary: MapProblemSummary,
) {
  trackLayer.clearLayers()
  problemsLayer.clearLayers()

  if (analysis.track.length === 0) return

  const latlngs = downsampleTrack(analysis.track, TRACK_DISPLAY_MAX)

  if (summary.denseOversample) {
    addCasedPolyline(trackLayer, latlngs, {
      color: OVERSAMPLE_COLOR,
      weight: 5,
      dashArray: '10 8',
    })

    const idxs = [
      0,
      Math.floor(analysis.track.length / 2),
      analysis.track.length - 1,
    ]
    for (const i of idxs) {
      const p = analysis.track[i]
      if (!p) continue
      addAnomalyMarker(problemsLayer, [p.lat, p.lon], 9)
    }
  } else {
    addCasedPolyline(trackLayer, latlngs, {
      color: TRACK_COLOR,
      weight: 5,
    })
  }

  const sparseDups: L.LatLngExpression[] = []
  for (const problem of analysis.problems) {
    if (problem.kind === 'dup-time') {
      if (summary.denseOversample) continue
      const c = problem.coords[0]
      if (c) sparseDups.push([c.lat, c.lon])
      continue
    }
    const line: L.LatLngExpression[] = problem.coords.map((p) => [p.lat, p.lon])
    if (line.length < 2) continue
    addCasedPolyline(problemsLayer, line, {
      color: PROBLEM_COLOR,
      weight: 6,
    })
    // Endpoints of gap/speed segments as red anomaly dots.
    const first = problem.coords[0]
    const last = problem.coords[problem.coords.length - 1]
    if (first) addAnomalyMarker(problemsLayer, [first.lat, first.lon], 7)
    if (last && last !== first) {
      addAnomalyMarker(problemsLayer, [last.lat, last.lon], 7)
    }
  }

  for (const ll of sparseDups) {
    addAnomalyMarker(problemsLayer, ll, 8)
  }
}

function TrackMapInner({ analysis }: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const trackLayerRef = useRef<L.LayerGroup | null>(null)
  const problemsLayerRef = useRef<L.LayerGroup | null>(null)
  const basemapsRef = useRef<Record<BasemapId, L.TileLayer> | null>(null)
  const analysisRef = useRef(analysis)
  analysisRef.current = analysis

  const [basemap, setBasemap] = useState<BasemapId>('map')

  const summary = useMemo(() => summarizeMapProblems(analysis), [analysis])
  const summaryRef = useRef(summary)
  summaryRef.current = summary

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const leafletEl = el as HTMLElement & { _leaflet_id?: number }
    if (leafletEl._leaflet_id) {
      delete leafletEl._leaflet_id
      el.replaceChildren()
    }

    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    })

    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution:
        'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      maxZoom: 17,
    })

    const esri = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution:
          'Tiles &copy; Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxZoom: 19,
      },
    )

    basemapsRef.current = { map: osm, topo, satellite: esri }

    const map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
    }).setView([0, 0], 2)

    osm.addTo(map)

    const trackLayer = L.layerGroup().addTo(map)
    const problemsLayer = L.layerGroup().addTo(map)
    trackLayerRef.current = trackLayer
    problemsLayerRef.current = problemsLayer
    mapRef.current = map

    const draw = (a: GpxAnalysis, s: MapProblemSummary) => {
      map.invalidateSize()
      if (a.track.length === 0) {
        trackLayer.clearLayers()
        problemsLayer.clearLayers()
        map.setView([0, 0], 2)
        return
      }
      paintAnalysis(trackLayer, problemsLayer, a, s)
      const bounds = L.latLngBounds(
        [a.latMin, a.lonMin],
        [a.latMax, a.lonMax],
      )
      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.08))
      }
    }

    const ro = new ResizeObserver(() => {
      map.invalidateSize()
    })
    ro.observe(el)

    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      draw(analysisRef.current, summaryRef.current)
    })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mapRef.current = null
      trackLayerRef.current = null
      problemsLayerRef.current = null
      basemapsRef.current = null
      try {
        map.remove()
      } catch {
        // StrictMode remount can leave renderer mid-teardown.
      }
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layers = basemapsRef.current
    if (!map || !layers) return
    for (const id of Object.keys(layers) as BasemapId[]) {
      const layer = layers[id]
      if (id === basemap) {
        if (!map.hasLayer(layer)) layer.addTo(map)
      } else if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [basemap])

  useEffect(() => {
    const map = mapRef.current
    const trackLayer = trackLayerRef.current
    const problemsLayer = problemsLayerRef.current
    if (!map || !trackLayer || !problemsLayer) return

    map.invalidateSize()
    if (analysis.track.length === 0) {
      trackLayer.clearLayers()
      problemsLayer.clearLayers()
      map.setView([0, 0], 2)
      return
    }

    paintAnalysis(trackLayer, problemsLayer, analysis, summary)
    const bounds = L.latLngBounds(
      [analysis.latMin, analysis.lonMin],
      [analysis.latMax, analysis.lonMax],
    )
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.08))
    }
  }, [analysis, summary])

  return (
    <div className="track-map-shell">
      <div
        className="basemap-toggle"
        role="group"
        aria-label="Basemap"
      >
        {(
          [
            ['map', 'Map'],
            ['topo', 'Topo'],
            ['satellite', 'Satellite'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={basemap === id ? 'active' : undefined}
            onClick={() => setBasemap(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        ref={containerRef}
        className="track-map"
        role="img"
        aria-label="Track map"
      />
    </div>
  )
}

type BoundaryState = { error: string | null }

class TrackMapBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error: error.message || 'Map failed to render' }
  }

  render() {
    if (this.state.error) {
      return (
        <p className="map-error" role="alert">
          Map unavailable: {this.state.error}
        </p>
      )
    }
    return this.props.children
  }
}

export default function TrackMap(props: TrackMapProps) {
  return (
    <TrackMapBoundary>
      <TrackMapInner {...props} />
    </TrackMapBoundary>
  )
}
