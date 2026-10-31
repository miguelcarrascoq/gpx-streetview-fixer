import { useMemo, useState } from 'react'
import {
  fixGpx,
  formatGpxTime,
  type FixResult,
  type GpxIssue,
} from './lib/gpxStreetView'
import './App.css'

function severityClass(s: GpxIssue['severity']): string {
  return `issue issue-${s}`
}

function AnalysisCard({
  title,
  result,
  which,
}: {
  title: string
  result: FixResult
  which: 'before' | 'after'
}) {
  const a = which === 'before' ? result.analysisBefore : result.analysisAfter
  return (
    <section className="card">
      <h2>{title}</h2>
      <dl className="stats">
        <div>
          <dt>Puntos</dt>
          <dd>{a.pointCount.toLocaleString('es-CL')}</dd>
        </div>
        <div>
          <dt>Duración</dt>
          <dd>{Math.round(a.durationSeconds)} s</dd>
        </div>
        <div>
          <dt>Distancia</dt>
          <dd>{a.distanceKm.toFixed(2)} km</dd>
        </div>
        <div>
          <dt>Vmáx</dt>
          <dd>{a.maxSpeedKmh.toFixed(1)} km/h</dd>
        </div>
      </dl>
      {a.timeStart && a.timeEnd && (
        <p className="mono">
          {formatGpxTime(a.timeStart)} → {formatGpxTime(a.timeEnd)}
        </p>
      )}
      <p className="mono subtle">
        lat [{a.latMin.toFixed(5)}, {a.latMax.toFixed(5)}] · lon [
        {a.lonMin.toFixed(5)}, {a.lonMax.toFixed(5)}]
      </p>
      <ul className="issues">
        {a.issues.map((issue) => (
          <li key={issue.id} className={severityClass(issue.severity)}>
            <span className="tag">{issue.severity}</span>
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function App() {
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<FixResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [startOverride, setStartOverride] = useState('')
  const [offset, setOffset] = useState('-3')

  const errorCount = useMemo(
    () => result?.analysisAfter.issues.filter((i) => i.severity === 'error').length ?? 0,
    [result],
  )

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    setResult(null)
    setFileName(file.name)
    try {
      const xml = await file.text()
      const offsetN = Number(offset)
      const videoStartUtc =
        startOverride.trim().length > 0 ? new Date(startOverride.trim()) : null
      if (videoStartUtc && Number.isNaN(videoStartUtc.getTime())) {
        throw new Error('Hora de inicio inválida. Usa ISO UTC, ej. 2025-11-17T08:48:32Z')
      }
      const fixed = fixGpx(xml, {
        sourceFilename: file.name,
        utcOffsetHours: Number.isFinite(offsetN) ? offsetN : -3,
        videoStartUtc,
      })
      setResult(fixed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function download() {
    if (!result) return
    const blob = new Blob([result.gpxXml], { type: 'application/gpx+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = result.outputFilename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page">
      <header className="hero">
        <p className="brand">GPX Street View Fixer</p>
        <h1>Deja tu track listo para Google Street View</h1>
        <p className="lede">
          Corrige bounds de Insta360, alinea la hora con el video VID_* y deja 1
          punto por segundo — lo que Street View Studio suele exigir para aprobar.
        </p>
      </header>

      <main className="main">
        <section className="panel">
          <label className="drop" htmlFor="gpx-file">
            <input
              id="gpx-file"
              type="file"
              accept=".gpx,application/gpx+xml,text/xml"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleFile(f)
              }}
            />
            <span className="drop-title">
              {busy ? 'Procesando…' : 'Suelta o elige un .gpx'}
            </span>
            <span className="drop-sub">
              Ideal: nombre VID_YYYYMMDD_HHMMSS (hora local de la cámara)
            </span>
          </label>

          <div className="controls">
            <label>
              Offset cámara (horas UTC)
              <input
                type="number"
                step="1"
                value={offset}
                onChange={(e) => setOffset(e.target.value)}
              />
            </label>
            <label>
              Inicio video UTC (opcional)
              <input
                type="text"
                placeholder="2025-11-17T08:48:32Z"
                value={startOverride}
                onChange={(e) => setStartOverride(e.target.value)}
              />
            </label>
          </div>

          {fileName && <p className="file-name">Archivo: {fileName}</p>}
          {error && <p className="error">{error}</p>}
        </section>

        {result && (
          <>
            <section className="card applied">
              <h2>Correcciones aplicadas</h2>
              <ol>
                {result.applied.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <button type="button" className="cta" onClick={download}>
                Descargar {result.outputFilename}
              </button>
              {errorCount === 0 ? (
                <p className="ok">
                  Listo para subir el MP4 360 + este GPX en Street View Studio.
                </p>
              ) : (
                <p className="warn">
                  Aún hay {errorCount} problema(s). Revisa el informe “Después”.
                </p>
              )}
            </section>

            <div className="grid">
              <AnalysisCard title="Antes" result={result} which="before" />
              <AnalysisCard title="Después" result={result} which="after" />
            </div>
          </>
        )}

        <section className="card howto">
          <h2>Cómo procesar otros GPX</h2>
          <ol>
            <li>
              Exporta el GPX desde Insta360 Studio junto al MP4 360 del mismo clip.
            </li>
            <li>
              Conserva el prefijo <code>VID_YYYYMMDD_HHMMSS</code> en el nombre (hora
              local de la cámara; en Chile usamos UTC−3).
            </li>
            <li>
              Aquí en la web, o por terminal:
              <pre>
                {`npm install
npm run fix -- ./ruta/VID_20251117_054832_00_003.gpx`}
              </pre>
            </li>
            <li>
              Sube el video y el archivo <code>*_streetview.gpx</code> en{' '}
              <a
                href="https://streetviewstudio.maps.google.com/"
                target="_blank"
                rel="noreferrer"
              >
                Street View Studio
              </a>{' '}
              → Upload → More → Upload GPX file.
            </li>
          </ol>
          <p className="subtle">
            Solo análisis: <code>npm run analyze -- archivo.gpx</code>. Si la hora del
            MP4 no coincide con el nombre, fuerza UTC con{' '}
            <code>--start 2025-11-17T08:48:32Z</code>.
          </p>
        </section>
      </main>
    </div>
  )
}
