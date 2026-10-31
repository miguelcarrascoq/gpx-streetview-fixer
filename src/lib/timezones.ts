import { formatUtcOffsetHours } from './gpxStreetView'

export const DEFAULT_TIME_ZONE = 'America/Santiago'

export type TimeZoneOption = {
  id: string
  city: string
  region: string
  /** English long name, e.g. "Chile Summer Time". Empty when Intl only returns a GMT offset. */
  longName: string
  detail: string
  /** Hours ahead of UTC at the instant the list was built. Chile summer = -3. */
  offsetHours: number
  offsetLabel: string
  search: string
}

const EXTRA_KEYWORDS: Record<string, string> = {
  'America/Santiago': 'chile',
  'America/Punta_Arenas': 'chile magallanes patagonia',
  'America/Coyhaique': 'chile aysen aysén',
  'Pacific/Easter': 'chile isla de pascua rapa nui',
}

/** Shown when Intl only reports a GMT offset, so the row still names the country. */
const COUNTRY_LABEL: Record<string, string> = {
  'America/Punta_Arenas': 'Chile',
  'America/Coyhaique': 'Chile',
}

let cached: TimeZoneOption[] | null = null

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replaceAll('−', '-')
    .replaceAll('–', '-')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

function cityAndRegion(id: string): { city: string; region: string } {
  if (id === 'UTC') return { city: 'UTC', region: 'Coordinated Universal Time' }
  const parts = id.split('/')
  return {
    city: (parts[parts.length - 1] ?? id).replaceAll('_', ' '),
    region: parts.slice(0, -1).join(' / ').replaceAll('_', ' '),
  }
}

function longName(timeZone: string, locale: string, instant: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone,
      timeZoneName: 'long',
    }).formatToParts(instant)
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** Offset of `timeZone` at `instant`, in hours ahead of UTC. */
export function utcOffsetHoursAt(timeZone: string, instant: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const bag: Record<string, string> = {}
    for (const part of dtf.formatToParts(instant)) {
      if (part.type !== 'literal') bag[part.type] = part.value
    }
    let hour = Number(bag.hour)
    if (hour === 24) hour = 0
    const asUtc = Date.UTC(
      Number(bag.year),
      Number(bag.month) - 1,
      Number(bag.day),
      hour,
      Number(bag.minute),
      Number(bag.second),
    )
    return Math.round((asUtc - instant.getTime()) / 60_000) / 60
  } catch {
    return -3
  }
}

/**
 * Offset for a camera wall-clock (the VID_* timestamp), refined once so a
 * daylight-saving transition a few hours away is not misread.
 */
export function utcOffsetHoursForWallClock(
  timeZone: string,
  wall: { y: number; mo: number; d: number; h: number; mi: number; s: number },
): number {
  const approx = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s))
  const first = utcOffsetHoursAt(timeZone, approx)
  return utcOffsetHoursAt(timeZone, new Date(approx.getTime() - first * 3_600_000))
}

function offsetSearch(hours: number): string {
  const label = formatUtcOffsetHours(hours).toLowerCase()
  const signed = label.slice(3)
  return [label, `gmt${signed}`, signed].join(' ')
}

function includedZone(id: string): boolean {
  if (id === 'UTC') return true
  if (id.startsWith('Etc/')) return false
  return id.includes('/')
}

export function listTimeZones(): TimeZoneOption[] {
  if (cached) return cached
  const instant = new Date()
  let ids: string[] = []
  try {
    ids = Intl.supportedValuesOf('timeZone').filter(includedZone)
  } catch {
    ids = ['UTC', 'America/Santiago']
  }
  if (!ids.includes('UTC')) ids.push('UTC')
  if (!ids.includes(DEFAULT_TIME_ZONE)) ids.push(DEFAULT_TIME_ZONE)

  const zones = ids.map((id) => {
    const { city, region } = cityAndRegion(id)
    const en = longName(id, 'en', instant)
    const es = longName(id, 'es', instant)
    const named = en.length > 0 && !/^gmt|^utc/i.test(en)
    const country = COUNTRY_LABEL[id]
    const detail = named
      ? region
        ? `${region} · ${en}`
        : en
      : country
        ? region
          ? `${region} · ${country}`
          : country
        : region || en
    const offsetHours = utcOffsetHoursAt(id, instant)
    const offsetLabel = formatUtcOffsetHours(offsetHours)
    const search = normalize(
      [city, region, id, en, es, offsetLabel, offsetSearch(offsetHours), EXTRA_KEYWORDS[id] ?? ''].join(
        ' ',
      ),
    )
    return { id, city, region, longName: named ? en : '', detail, offsetHours, offsetLabel, search }
  })

  zones.sort(
    (a, b) =>
      a.city.localeCompare(b.city, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id),
  )
  cached = zones
  return zones
}

function rankZone(zone: TimeZoneOption, tokens: string[]): number {
  const city = normalize(zone.city)
  const cityWords = city.split(/\s+/).filter(Boolean)
  const joined = tokens.join(' ')
  if (city === joined) return 0
  if (tokens.every((token) => cityWords.some((word) => word.startsWith(token)))) return 1
  const longName = normalize(zone.longName)
  if (longName.startsWith(joined)) return 2
  return 3
}

export function filterTimeZones(zones: TimeZoneOption[], query: string): TimeZoneOption[] {
  const q = normalize(query).trim()
  if (!q) {
    const utc = zones.filter((zone) => zone.id === 'UTC')
    const rest = zones.filter((zone) => zone.id !== 'UTC')
    return [...utc, ...rest]
  }
  const tokens = q.split(/\s+/).filter(Boolean)
  return zones
    .filter((zone) => tokens.every((token) => zone.search.includes(token)))
    .sort(
      (a, b) =>
        rankZone(a, tokens) - rankZone(b, tokens) ||
        a.city.localeCompare(b.city, 'en', { sensitivity: 'base' }),
    )
}
