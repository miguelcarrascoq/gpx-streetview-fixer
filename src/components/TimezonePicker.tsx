import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { filterTimeZones, listTimeZones } from '../lib/timezones'

type Props = {
  value: string
  onChange: (timeZone: string) => void
  disabled?: boolean
}

export default function TimezonePicker({ value, onChange, disabled }: Props) {
  const zones = useMemo(() => listTimeZones(), [])
  const selected = zones.find((zone) => zone.id === value) ?? zones[0]
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [scrollTick, setScrollTick] = useState(0)
  const listId = useId()

  const filtered = useMemo(() => filterTimeZones(zones, query), [zones, query])
  const activeIndex = Math.min(active, Math.max(filtered.length - 1, 0))
  const activeId = filtered[activeIndex] ? `${listId}-opt-${activeIndex}` : undefined

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const option = list?.querySelector('[data-active="true"]')
    if (!list || !(option instanceof HTMLElement)) return
    const listRect = list.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.top < listRect.top) {
      list.scrollTop -= listRect.top - optionRect.top
    } else if (optionRect.bottom > listRect.bottom) {
      list.scrollTop += optionRect.bottom - listRect.bottom
    }
  }, [open, scrollTick])

  function reveal(index: number) {
    setActive(index)
    setScrollTick((tick) => tick + 1)
  }

  function openList() {
    const index = filterTimeZones(zones, '').findIndex((zone) => zone.id === value)
    setQuery('')
    reveal(index >= 0 ? index : 0)
    setOpen(true)
  }

  function choose(id: string) {
    onChange(id)
    setOpen(false)
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      reveal(Math.min(activeIndex + 1, Math.max(filtered.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      reveal(Math.max(activeIndex - 1, 0))
    } else if (event.key === 'Home') {
      event.preventDefault()
      reveal(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      reveal(Math.max(filtered.length - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const zone = filtered[activeIndex]
      if (zone) choose(zone.id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div
      className="tz"
      ref={rootRef}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && rootRef.current?.contains(next)) return
        window.setTimeout(() => {
          if (!rootRef.current?.contains(document.activeElement)) setOpen(false)
        }, 0)
      }}
    >
      <button
        type="button"
        className="tz-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={selected ? `${selected.city} · ${selected.detail} · ${selected.offsetLabel}` : value}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (!open && event.key === 'ArrowDown') {
            event.preventDefault()
            openList()
          }
        }}
      >
        <span className="tz-city">{selected?.city ?? value}</span>
        <span className="tz-detail">{selected?.detail}</span>
        <span className="tz-offset">{selected?.offsetLabel}</span>
      </button>
      {open && (
        <div className="tz-pop">
          <input
            ref={searchRef}
            className="tz-search"
            type="search"
            placeholder="Search city, country, or UTC offset"
            value={query}
            aria-label="Search time zones"
            aria-controls={listId}
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value)
              reveal(0)
            }}
            onKeyDown={onSearchKey}
          />
          <ul ref={listRef} id={listId} className="tz-list" role="listbox" aria-label="Time zones">
            {filtered.length === 0 ? (
              <li className="tz-empty">No zones match “{query.trim()}”.</li>
            ) : (
              filtered.map((zone, index) => (
                <li key={zone.id} role="presentation">
                  <button
                    type="button"
                    id={`${listId}-opt-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={zone.id === value}
                    data-active={index === activeIndex ? 'true' : undefined}
                    className={index === activeIndex ? 'is-active' : undefined}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(zone.id)}
                  >
                    <span className="tz-city">{zone.city}</span>
                    <span className="tz-offset">{zone.offsetLabel}</span>
                    <span className="tz-detail">{zone.detail}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
