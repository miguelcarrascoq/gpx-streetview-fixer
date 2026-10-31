import { Component, useEffect, useRef, type ReactNode } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GpxAnalysis } from '../lib/gpxStreetView'

const TRACK_COLOR = '#7eb8a4'
const PROBLEM_COLOR = '#ef4444'
/** Above this, draw dup-time as one polyline instead of many markers. */
const DUP_MARKER_LIMIT = 400
/** Max vertices kept for the base track polyline. */
const TRACK_DISPLAY_MAX = 4000

type TrackMapProps = {
  analysis: GpxAnalysis
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

function paintProblems(layer: L.LayerGroup, analysis: GpxAnalysis) {
  const dups: L.LatLngExpression[] = []
  for (const problem of analysis.problems) {
    if (problem.kind === 'dup-time') {
      const c = problem.coords[0]
      if (c) dups.push([c.lat, c.lon])
      continue
    }
    const line: L.LatLngExpression[] = problem.coords.map((p) => [p.lat, p.lon])
    if (line.length < 2) continue
    L.polyline(line, {
      color: PROBLEM_COLOR,
      weight: 4,
      opacity: 0.95,
    }).addTo(layer)
  }

  if (dups.length > DUP_MARKER_LIMIT) {
    L.polyline(dups, {
      color: PROBLEM_COLOR,
      weight: 5,
      opacity: 0.75,
    }).addTo(layer)
  } else {
    for (const ll of dups) {
      L.circleMarker(ll, {
        radius: 5,
        color: PROBLEM_COLOR,
        fillColor: PROBLEM_COLOR,
        fillOpacity: 0.9,
        weight: 1,
      }).addTo(layer)
    }
  }
}

function TrackMapInner({ analysis }: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const trackLayerRef = useRef<L.LayerGroup | null>(null)
  const problemsLayerRef = useRef<L.LayerGroup | null>(null)
  const analysisRef = useRef(analysis)
  analysisRef.current = analysis

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

    // setView before any overlays — avoids Leaflet _pxBounds undefined crashes.
    const map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
    }).setView([0, 0], 2)

    osm.addTo(map)

    L.control
      .layers(
        {
          OpenStreetMap: osm,
          OpenTopoMap: topo,
          Satellite: esri,
        },
        undefined,
        { position: 'topright' },
      )
      .addTo(map)

    const trackLayer = L.layerGroup().addTo(map)
    const problemsLayer = L.layerGroup().addTo(map)
    trackLayerRef.current = trackLayer
    problemsLayerRef.current = problemsLayer
    mapRef.current = map

    const draw = (a: GpxAnalysis) => {
      trackLayer.clearLayers()
      problemsLayer.clearLayers()
      map.invalidateSize()

      if (a.track.length === 0) {
        map.setView([0, 0], 2)
        return
      }

      const latlngs = downsampleTrack(a.track, TRACK_DISPLAY_MAX)
      L.polyline(latlngs, {
        color: TRACK_COLOR,
        weight: 3,
        opacity: 0.85,
      }).addTo(trackLayer)

      paintProblems(problemsLayer, a)

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

    // Wait for layout so path clipping has a valid pixel bounds.
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      draw(analysisRef.current)
    })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mapRef.current = null
      trackLayerRef.current = null
      problemsLayerRef.current = null
      try {
        map.remove()
      } catch {
        // StrictMode remount can leave canvas/SVG mid-teardown.
      }
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const trackLayer = trackLayerRef.current
    const problemsLayer = problemsLayerRef.current
    if (!map || !trackLayer || !problemsLayer) return

    trackLayer.clearLayers()
    problemsLayer.clearLayers()
    map.invalidateSize()

    if (analysis.track.length === 0) {
      map.setView([0, 0], 2)
      return
    }

    const latlngs = downsampleTrack(analysis.track, TRACK_DISPLAY_MAX)
    L.polyline(latlngs, {
      color: TRACK_COLOR,
      weight: 3,
      opacity: 0.85,
    }).addTo(trackLayer)

    paintProblems(problemsLayer, analysis)

    const bounds = L.latLngBounds(
      [analysis.latMin, analysis.lonMin],
      [analysis.latMax, analysis.lonMax],
    )
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.08))
    }
  }, [analysis])

  return <div ref={containerRef} className="track-map" role="img" aria-label="Track map" />
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
