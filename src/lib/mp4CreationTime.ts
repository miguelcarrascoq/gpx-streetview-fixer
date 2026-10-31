/**
 * Read MP4 / QuickTime creation time without loading the whole file.
 * Street View Studio uses this (ffprobe `format.tags.creation_time`) as the
 * video time range — often different from the Insta360 VID_* filename clock.
 */

/** Seconds between 1904-01-01 and 1970-01-01 (QuickTime / MP4 epoch). */
const MAC_EPOCH_OFFSET_S = 2082844800

const ISO_CREATION_RE =
  // Separators between key and value may include NULs from QuickTime atoms.
  // eslint-disable-next-line no-control-regex -- binary metadata scan
  /(?:creation_time|com\.apple\.quicktime\.creationdate)[\x00-\x20]*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i

const LOOSE_ISO_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/

function decodeType(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

type Box = {
  type: string
  /** Absolute file offset of box start, if known. */
  fileOffset?: number
  headerSize: number
  contentStart: number
  contentEnd: number
  /** Full box size in the file (may exceed this buffer). */
  boxSize: number
}

function readBox(view: DataView, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null
  let size = view.getUint32(offset)
  const type = decodeType(view, offset + 4)
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > limit) return null
    const hi = view.getUint32(offset + 8)
    const lo = view.getUint32(offset + 12)
    size = hi * 2 ** 32 + lo
    headerSize = 16
  } else if (size === 0) {
    size = limit - offset
  }
  if (size < headerSize) return null
  const contentStart = offset + headerSize
  const contentEnd = Math.min(offset + size, limit)
  return {
    type,
    headerSize,
    contentStart,
    contentEnd,
    boxSize: size,
  }
}

function walkTopLevel(
  view: DataView,
  start: number,
  end: number,
  visit: (box: Box, absoluteStart: number) => boolean | void,
  fileBase = 0,
): boolean {
  let offset = start
  while (offset + 8 <= end) {
    const box = readBox(view, offset, end)
    if (!box) break
    if (visit({ ...box, fileOffset: fileBase + offset }, fileBase + offset)) {
      return true
    }
    // Advance by declared size even if content was truncated in this buffer
    const next = offset + box.boxSize
    if (next <= offset) break
    offset = next
    if (offset > end) break
  }
  return false
}

function walkChildren(
  view: DataView,
  start: number,
  end: number,
  visit: (box: Box) => boolean | void,
): boolean {
  let offset = start
  while (offset + 8 <= end) {
    const box = readBox(view, offset, end)
    if (!box) break
    if (visit(box)) return true
    const fullSize = Math.min(box.boxSize, end - offset)
    if (fullSize <= 0) break
    offset += fullSize
  }
  return false
}

function parseMvhd(view: DataView, contentStart: number, contentEnd: number): Date | null {
  if (contentStart + 5 > contentEnd) return null
  const version = view.getUint8(contentStart)
  let creationSeconds: number
  if (version === 0) {
    if (contentStart + 8 > contentEnd) return null
    creationSeconds = view.getUint32(contentStart + 4)
  } else if (version === 1) {
    if (contentStart + 12 > contentEnd) return null
    const hi = view.getUint32(contentStart + 4)
    const lo = view.getUint32(contentStart + 8)
    creationSeconds = hi * 2 ** 32 + lo
  } else {
    return null
  }
  if (creationSeconds === 0) return null
  const unixMs = (creationSeconds - MAC_EPOCH_OFFSET_S) * 1000
  const d = new Date(unixMs)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  if (y < 1990 || y > 2100) return null
  return d
}

function dateFromMoov(view: DataView, moovContentStart: number, moovContentEnd: number): Date | null {
  let found: Date | null = null
  walkChildren(view, moovContentStart, moovContentEnd, (child) => {
    if (child.type === 'mvhd') {
      found = parseMvhd(view, child.contentStart, child.contentEnd)
      return found != null
    }
    return false
  })
  return found
}

function findMoovInBuffer(buffer: ArrayBuffer, fileBase = 0): Date | null {
  const view = new DataView(buffer)
  let found: Date | null = null
  walkTopLevel(
    view,
    0,
    buffer.byteLength,
    (box) => {
      if (box.type !== 'moov') return false
      found = dateFromMoov(view, box.contentStart, box.contentEnd)
      return found != null
    },
    fileBase,
  )
  if (found) return found

  // Unaligned slice (e.g. raw tail): scan for 'moov' fourcc
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (
      bytes[i + 4] === 0x6d &&
      bytes[i + 5] === 0x6f &&
      bytes[i + 6] === 0x6f &&
      bytes[i + 7] === 0x76
    ) {
      const box = readBox(view, i, buffer.byteLength)
      if (box?.type === 'moov') {
        found = dateFromMoov(view, box.contentStart, box.contentEnd)
        if (found) return found
      }
    }
  }
  return null
}

function findTaggedCreationTime(buffer: ArrayBuffer): Date | null {
  const text = new TextDecoder('latin1').decode(buffer)
  const tagged = text.match(ISO_CREATION_RE)
  if (tagged?.[1]) {
    const iso = tagged[1].includes('T') ? tagged[1] : tagged[1].replace(' ', 'T')
    const withZ = /Z$/i.test(iso) ? iso : `${iso}Z`
    const d = new Date(withZ)
    if (!Number.isNaN(d.getTime())) return d
  }
  const loose = text.match(LOOSE_ISO_RE)
  if (loose?.[1]) {
    const d = new Date(loose[1])
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

async function readSlice(file: Blob, start: number, length: number): Promise<ArrayBuffer> {
  const end = Math.min(file.size, start + length)
  if (start >= end) return new ArrayBuffer(0)
  return file.slice(start, end).arrayBuffer()
}

type TopLayout = {
  moovAt: number | null
  afterMdat: number | null
}

function inspectTopLevel(buffer: ArrayBuffer): TopLayout {
  const view = new DataView(buffer)
  let moovAt: number | null = null
  let afterMdat: number | null = null
  let offset = 0
  const end = buffer.byteLength
  while (offset + 8 <= end) {
    const box = readBox(view, offset, end)
    if (!box) break
    if (box.type === 'moov') moovAt = offset
    if (box.type === 'mdat') afterMdat = offset + box.boxSize
    const next = offset + box.boxSize
    if (next <= offset) break
    // Declared box extends past this buffer — still record mdat end
    if (next > end) break
    offset = next
  }
  return { moovAt, afterMdat }
}

/**
 * Extract creation time from an MP4/MOV `File` or `Blob`.
 * Reads only the head and (if needed) the moov region so multi‑GB exports stay workable.
 */
export async function readMp4CreationTime(file: Blob): Promise<Date | null> {
  if (file.size < 16) return null

  const HEAD = 4 * 1024 * 1024
  const headLen = Math.min(HEAD, file.size)
  const head = await readSlice(file, 0, headLen)

  let tagged = findTaggedCreationTime(head)
  if (tagged) return tagged
  let mvhd = findMoovInBuffer(head)
  if (mvhd) return mvhd

  const layout = inspectTopLevel(head)
  if (layout.moovAt != null) {
    // Truncated moov in head — re-read a larger window from moovAt (unlikely for small head)
    const more = await readSlice(file, layout.moovAt, 4 * 1024 * 1024)
    tagged = findTaggedCreationTime(more)
    if (tagged) return tagged
    mvhd = findMoovInBuffer(more)
    if (mvhd) return mvhd
  }

  if (layout.afterMdat != null && layout.afterMdat < file.size) {
    const moovStart = layout.afterMdat
    const moovLen = Math.min(file.size - moovStart, 8 * 1024 * 1024)
    const moovBuf = await readSlice(file, moovStart, moovLen)
    tagged = findTaggedCreationTime(moovBuf)
    if (tagged) return tagged
    mvhd = findMoovInBuffer(moovBuf)
    if (mvhd) return mvhd
  }

  // Last resort: scan the file tail for an unaligned moov
  if (file.size > HEAD) {
    const TAIL = 16 * 1024 * 1024
    const tailStart = Math.max(0, file.size - TAIL)
    const tail = await readSlice(file, tailStart, file.size - tailStart)
    tagged = findTaggedCreationTime(tail)
    if (tagged) return tagged
    mvhd = findMoovInBuffer(tail)
    if (mvhd) return mvhd
  }

  return null
}

export function formatMp4CreationTimeUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
