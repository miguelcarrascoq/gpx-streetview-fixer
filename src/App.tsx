import { useMemo, useState } from 'react'
import TimezonePicker from './components/TimezonePicker'
import TrackMap from './components/TrackMap'
import {
  fixGpx,
  formatGpxTime,
  inferVideoStartFromFilename,
  parseGpx,
  parseVidLocalParts,
  type FixResult,
  type GpxIssue,
  type SyncSource,
} from './lib/gpxStreetView'
import {
  formatMp4CreationTimeUtc,
  readMp4CreationTime,
} from './lib/mp4CreationTime'
import {
  DEFAULT_TIME_ZONE,
  utcOffsetHoursAt,
  utcOffsetHoursForWallClock,
} from './lib/timezones'
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
      {a.videoStartTarget && (
        <p className="mono subtle">
          Sync target ({a.videoStartTargetLabel ?? 'video'}):{' '}
          {formatGpxTime(a.videoStartTarget)}
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

type SyncMode = SyncSource

export default function App() {
  const [fileName, setFileName] = useState<string | null>(null)
  const [gpxXml, setGpxXml] = useState<string | null>(null)
  const [result, setResult] = useState<FixResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manualStart, setManualStart] = useState('')
  const [mp4Name, setMp4Name] = useState<string | null>(null)
  const [mp4CreationUtc, setMp4CreationUtc] = useState<Date | null>(null)
  const [syncMode, setSyncMode] = useState<SyncMode>('filename')
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE)
  const [mapWhich, setMapWhich] = useState<'before' | 'after'>('before')
  const [vidVsGpxHint, setVidVsGpxHint] = useState<string | null>(null)
  const errorCount = useMemo(
    () => result?.analysisAfter.issues.filter((i) => i.severity === 'error').length ?? 0,
    [result],
  )

  const mapAnalysis = useMemo(() => {
    if (!result) return null
    return mapWhich === 'before' ? result.analysisBefore : result.analysisAfter
  }, [result, mapWhich])

  const filenameStartPreview = useMemo(() => {
    if (!fileName) return null
    const wall = parseVidLocalParts(fileName)
    if (!wall) return null
    const offsetN = utcOffsetHoursForWallClock(timeZone, wall)
    return inferVideoStartFromFilename(
      fileName,
      Number.isFinite(offsetN) ? offsetN : -3,
    )
  }, [fileName, timeZone])

  function resolveSync(xml: string, name: string): {
    syncSource: SyncMode
    videoStartUtc: Date | null
    videoStartLabel: string | null
    utcOffsetHours: number
  } {
    const wall = parseVidLocalParts(name)
    const offsetN = wall
      ? utcOffsetHoursForWallClock(timeZone, wall)
      : utcOffsetHoursAt(timeZone, new Date())
    const utcOffsetHours = Number.isFinite(offsetN) ? offsetN : -3

    if (syncMode === 'mp4') {
      if (!mp4CreationUtc) {
        throw new Error('Choose the matching .mp4 so we can read its creation_time.')
      }
      return {
        syncSource: 'mp4',
        videoStartUtc: mp4CreationUtc,
        videoStartLabel: 'MP4 creation_time',
        utcOffsetHours,
      }
    }
    if (syncMode === 'manual') {
      const raw = manualStart.trim()
      if (!raw) {
        throw new Error('Enter the MP4 creation_time as ISO UTC, e.g. 2026-09-14T17:11:54Z')
      }
      const videoStartUtc = new Date(raw)
      if (Number.isNaN(videoStartUtc.getTime())) {
        throw new Error('Invalid start time. Use ISO UTC, e.g. 2026-09-14T17:11:54Z')
      }
      return {
        syncSource: 'manual',
        videoStartUtc,
        videoStartLabel: 'manual video start',
        utcOffsetHours,
      }
    }
    if (syncMode === 'gpx') {
      return {
        syncSource: 'gpx',
        videoStartUtc: null,
        videoStartLabel: null,
        utcOffsetHours,
      }
    }
    void xml
    return {
      syncSource: 'filename',
      videoStartUtc: null,
      videoStartLabel: null,
      utcOffsetHours,
    }
  }

  function runFix(xml: string, name: string) {
    const { syncSource, videoStartUtc, videoStartLabel, utcOffsetHours } =
      resolveSync(xml, name)
    const fixed = fixGpx(xml, {
      sourceFilename: name,
      utcOffsetHours,
      syncSource,
      videoStartUtc,
      videoStartLabel,
    })
    setResult(fixed)
  }

  function refreshVidVsGpxHint(xml: string, name: string) {
    try {
      const parsed = parseGpx(xml)
      const wall = parseVidLocalParts(name)
      const offsetN = wall
        ? utcOffsetHoursForWallClock(timeZone, wall)
        : utcOffsetHoursAt(timeZone, new Date())
      const fromName = inferVideoStartFromFilename(
        name,
        Number.isFinite(offsetN) ? offsetN : -3,
      )
      const gpxStart = parsed.points[0]?.time
      if (fromName && gpxStart) {
        const deltaH =
          Math.abs(gpxStart.getTime() - fromName.getTime()) / 3_600_000
        if (deltaH >= 1) {
          setVidVsGpxHint(
            `GPX starts at ${formatGpxTime(gpxStart)} but VID_* implies ${formatGpxTime(fromName)}. Street View uses the MP4 creation_time — drop the .mp4 below (or keep GPX / paste the time). Aligning only to the filename often fails after Insta360 re-export.`,
          )
          return
        }
      }
      setVidVsGpxHint(null)
    } catch {
      setVidVsGpxHint(null)
    }
  }

  async function handleGpxFile(file: File) {
    setBusy(true)
    setError(null)
    setResult(null)
    setMapWhich('before')
    setFileName(file.name)
    try {
      const xml = await file.text()
      setGpxXml(xml)
      refreshVidVsGpxHint(xml, file.name)

      // Prefer MP4 when already loaded; otherwise if GPX ≠ VID_* by ≥1h, keep GPX.
      let nextMode = syncMode
      if (mp4CreationUtc) {
        nextMode = 'mp4'
      } else {
        const parsed = parseGpx(xml)
        const wall = parseVidLocalParts(file.name)
        const offsetN = wall
          ? utcOffsetHoursForWallClock(timeZone, wall)
          : utcOffsetHoursAt(timeZone, new Date())
        const fromName = inferVideoStartFromFilename(
          file.name,
          Number.isFinite(offsetN) ? offsetN : -3,
        )
        const gpxStart = parsed.points[0]?.time
        if (
          fromName &&
          gpxStart &&
          Math.abs(gpxStart.getTime() - fromName.getTime()) >= 3_600_000
        ) {
          nextMode = 'gpx'
        }
      }
      setSyncMode(nextMode)

      const { syncSource, videoStartUtc, videoStartLabel, utcOffsetHours } =
        (() => {
          const wall = parseVidLocalParts(file.name)
          const offsetN = wall
            ? utcOffsetHoursForWallClock(timeZone, wall)
            : utcOffsetHoursAt(timeZone, new Date())
          const utcOffsetHours = Number.isFinite(offsetN) ? offsetN : -3
          if (nextMode === 'mp4' && mp4CreationUtc) {
            return {
              syncSource: 'mp4' as const,
              videoStartUtc: mp4CreationUtc,
              videoStartLabel: 'MP4 creation_time',
              utcOffsetHours,
            }
          }
          if (nextMode === 'gpx') {
            return {
              syncSource: 'gpx' as const,
              videoStartUtc: null,
              videoStartLabel: null,
              utcOffsetHours,
            }
          }
          if (nextMode === 'manual') {
            const raw = manualStart.trim()
            const d = raw ? new Date(raw) : null
            if (!d || Number.isNaN(d.getTime())) {
              throw new Error(
                'Enter the MP4 creation_time as ISO UTC, e.g. 2026-09-14T17:11:54Z',
              )
            }
            return {
              syncSource: 'manual' as const,
              videoStartUtc: d,
              videoStartLabel: 'manual video start',
              utcOffsetHours,
            }
          }
          return {
            syncSource: 'filename' as const,
            videoStartUtc: null,
            videoStartLabel: null,
            utcOffsetHours,
          }
        })()

      setResult(
        fixGpx(xml, {
          sourceFilename: file.name,
          utcOffsetHours,
          syncSource,
          videoStartUtc,
          videoStartLabel,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleMp4File(file: File) {
    setBusy(true)
    setError(null)
    setMp4Name(file.name)
    try {
      const created = await readMp4CreationTime(file)
      if (!created) {
        setMp4CreationUtc(null)
        setSyncMode('manual')
        throw new Error(
          'Could not read creation_time from that MP4. Paste it manually (ffprobe format.tags.creation_time).',
        )
      }
      setMp4CreationUtc(created)
      setManualStart(formatMp4CreationTimeUtc(created))
      setSyncMode('mp4')
      if (gpxXml && fileName) {
        setResult(
          fixGpx(gpxXml, {
            sourceFilename: fileName,
            utcOffsetHours: (() => {
              const wall = parseVidLocalParts(fileName)
              const offsetN = wall
                ? utcOffsetHoursForWallClock(timeZone, wall)
                : utcOffsetHoursAt(timeZone, new Date())
              return Number.isFinite(offsetN) ? offsetN : -3
            })(),
            syncSource: 'mp4',
            videoStartUtc: created,
            videoStartLabel: 'MP4 creation_time',
          }),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function reprocess() {
    if (!gpxXml || !fileName) return
    setBusy(true)
    setError(null)
    try {
      runFix(gpxXml, fileName)
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
          Fixes Insta360 bounds, keeps 1 point per second, and aligns GPS time to
          the <strong>MP4 creation_time</strong> Street View actually checks —
          which often differs from the <code>VID_*</code> filename after re-export.
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
                if (f) void handleGpxFile(f)
              }}
            />
            <span className="drop-title">
              {busy ? 'Processing…' : 'Drop or choose a .gpx'}
            </span>
            <span className="drop-sub">
              Ideal: same clip as the 360 MP4 you will upload
            </span>
          </label>

          <label className="drop drop-mp4" htmlFor="mp4-file">
            <input
              id="mp4-file"
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleMp4File(f)
              }}
            />
            <span className="drop-title">
              {mp4CreationUtc
                ? `MP4 time: ${formatMp4CreationTimeUtc(mp4CreationUtc)}`
                : 'Optional: matching .mp4'}
            </span>
            <span className="drop-sub">
              Reads <code>creation_time</code> only (head/tail — safe for large exports).
              {mp4Name ? ` · ${mp4Name}` : ''}
            </span>
          </label>

          {vidVsGpxHint && <p className="sync-banner">{vidVsGpxHint}</p>}

          <div className="controls">
            <div className="field">
              <span className="field-label">Camera time zone</span>
              <TimezonePicker value={timeZone} onChange={setTimeZone} disabled={busy} />
              <span className="field-hint">
                Used only when syncing from the <code>VID_*</code> name.
              </span>
            </div>

            <fieldset className="field sync-field">
              <legend className="field-label">Align GPS to</legend>
              <div className="sync-options">
                <label className="sync-option">
                  <input
                    type="radio"
                    name="sync"
                    checked={syncMode === 'mp4'}
                    disabled={busy || !mp4CreationUtc}
                    onChange={() => setSyncMode('mp4')}
                  />
                  <span>
                    MP4 creation_time
                    {mp4CreationUtc
                      ? ` (${formatMp4CreationTimeUtc(mp4CreationUtc)})`
                      : ' — add .mp4 above'}
                  </span>
                </label>
                <label className="sync-option">
                  <input
                    type="radio"
                    name="sync"
                    checked={syncMode === 'gpx'}
                    disabled={busy}
                    onChange={() => setSyncMode('gpx')}
                  />
                  <span>Keep GPX timestamps (Insta360 export)</span>
                </label>
                <label className="sync-option">
                  <input
                    type="radio"
                    name="sync"
                    checked={syncMode === 'filename'}
                    disabled={busy}
                    onChange={() => setSyncMode('filename')}
                  />
                  <span>
                    VID_* filename
                    {filenameStartPreview
                      ? ` (${formatGpxTime(filenameStartPreview)})`
                      : ''}
                  </span>
                </label>
                <label className="sync-option">
                  <input
                    type="radio"
                    name="sync"
                    checked={syncMode === 'manual'}
                    disabled={busy}
                    onChange={() => setSyncMode('manual')}
                  />
                  <span>Manual UTC start</span>
                </label>
              </div>
              {(syncMode === 'manual' || syncMode === 'mp4') && (
                <label className="manual-start">
                  Video start UTC
                  <input
                    type="text"
                    placeholder="2026-09-14T17:11:54Z"
                    value={manualStart}
                    disabled={busy || syncMode === 'mp4'}
                    onChange={(e) => {
                      setManualStart(e.target.value)
                      if (syncMode !== 'manual') setSyncMode('manual')
                    }}
                  />
                </label>
              )}
              <span className="field-hint">
                Google rejects uploads when GPS and video ranges do not overlap.
                Prefer the MP4 whenever the export date disagrees with <code>VID_*</code>.
              </span>
            </fieldset>
          </div>

          {gpxXml && fileName && (
            <button
              type="button"
              className="cta cta-secondary"
              disabled={busy}
              onClick={reprocess}
            >
              Reprocess with current sync
            </button>
          )}

          {fileName && <p className="file-name">GPX: {fileName}</p>}
          {error && <p className="error">{error}</p>}
        </section>

        {result && (
          <>
            <section className="card applied">
              <h2>Fixes applied</h2>
              <dl className="stats stats-summary">
                <div>
                  <dt>Current points</dt>
                  <dd>
                    {result.analysisBefore.pointCount.toLocaleString('en-US')}
                  </dd>
                </div>
                <div>
                  <dt>Export points</dt>
                  <dd>
                    {result.analysisAfter.pointCount.toLocaleString('en-US')}
                  </dd>
                </div>
              </dl>
              <p className="mono subtle">
                Sync: {result.syncSource}
                {result.videoStartUtc
                  ? ` → ${formatGpxTime(result.videoStartUtc)}`
                  : ''}
              </p>
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

            {mapAnalysis && (
              <section className="card map-card">
                <div className="map-header">
                  <h2>Track map</h2>
                  <div className="map-toggle" role="group" aria-label="Map version">
                    <button
                      type="button"
                      className={mapWhich === 'before' ? 'active' : undefined}
                      onClick={() => setMapWhich('before')}
                    >
                      Before
                    </button>
                    <button
                      type="button"
                      className={mapWhich === 'after' ? 'active' : undefined}
                      onClick={() => setMapWhich('after')}
                    >
                      After
                    </button>
                  </div>
                </div>
                <div className="map-wrap">
                  <TrackMap analysis={mapAnalysis} />
                </div>
                <ul className="map-legend">
                  <li>
                    <span className="swatch track" /> Track
                  </li>
                  <li>
                    <span className="swatch gap" /> Gap / speed jump
                  </li>
                  <li>
                    <span className="swatch dup" /> Duplicate time
                  </li>
                </ul>
              </section>
            )}

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
              Drop the <code>.gpx</code> here. If the times disagree with{' '}
              <code>VID_*</code>, also drop the <code>.mp4</code> (or choose
              “Keep GPX timestamps”).
            </li>
            <li>
              Or via terminal, force the MP4 time:
              <pre>
                {`npm run fix -- ./clip.gpx --start 2026-09-14T17:11:54Z`}
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
            Street View compares GPS range to the MP4 <code>creation_time</code>,
            not the camera filename. After a Studio re-export those often diverge.
          </p>
        </section>
      </main>
    </div>
  )
}
