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
          <dt>Points</dt>
          <dd>{a.pointCount.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{Math.round(a.durationSeconds)} s</dd>
        </div>
        <div>
          <dt>Distance</dt>
          <dd>{a.distanceKm.toFixed(2)} km</dd>
        </div>
        <div>
          <dt>Max speed</dt>
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
        throw new Error('Invalid start time. Use ISO UTC, e.g. 2025-11-17T08:48:32Z')
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
        <h1>Get your track ready for Google Street View</h1>
        <p className="lede">
          Fixes Insta360 bounds, aligns time with the VID_* video, and keeps 1
          point per second — what Street View Studio usually needs to approve.
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
              {busy ? 'Processing…' : 'Drop or choose a .gpx'}
            </span>
            <span className="drop-sub">
              Ideal: VID_YYYYMMDD_HHMMSS name (camera local time)
            </span>
          </label>

          <div className="controls">
            <label>
              Camera offset (UTC hours)
              <input
                type="number"
                step="1"
                value={offset}
                onChange={(e) => setOffset(e.target.value)}
              />
            </label>
            <label>
              Video start UTC (optional)
              <input
                type="text"
                placeholder="2025-11-17T08:48:32Z"
                value={startOverride}
                onChange={(e) => setStartOverride(e.target.value)}
              />
            </label>
          </div>

          {fileName && <p className="file-name">File: {fileName}</p>}
          {error && <p className="error">{error}</p>}
        </section>

        {result && (
          <>
            <section className="card applied">
              <h2>Fixes applied</h2>
              <ol>
                {result.applied.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <button type="button" className="cta" onClick={download}>
                Download {result.outputFilename}
              </button>
              {errorCount === 0 ? (
                <p className="ok">
                  Ready to upload the 360 MP4 + this GPX in Street View Studio.
                </p>
              ) : (
                <p className="warn">
                  Still {errorCount} issue(s). Review the “After” report.
                </p>
              )}
            </section>

            <div className="grid">
              <AnalysisCard title="Before" result={result} which="before" />
              <AnalysisCard title="After" result={result} which="after" />
            </div>
          </>
        )}

        <section className="card howto">
          <h2>How to process other GPX files</h2>
          <ol>
            <li>
              Export the GPX from Insta360 Studio together with the 360 MP4 of the same clip.
            </li>
            <li>
              Keep the <code>VID_YYYYMMDD_HHMMSS</code> prefix in the name (camera
              local time; for Chile we use UTC−3).
            </li>
            <li>
              Here in the web app, or via terminal:
              <pre>
                {`npm install
npm run fix -- ./path/VID_20251117_054832_00_003.gpx`}
              </pre>
            </li>
            <li>
              Upload the video and the <code>*_streetview.gpx</code> file in{' '}
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
            Analysis only: <code>npm run analyze -- file.gpx</code>. If the MP4
            time does not match the name, force UTC with{' '}
            <code>--start 2025-11-17T08:48:32Z</code>.
          </p>
        </section>
      </main>
    </div>
  )
}
