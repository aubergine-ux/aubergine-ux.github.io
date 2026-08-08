document.addEventListener('contextmenu', e => e.preventDefault());

// Sort the gallery by the date each photo was actually taken.
//
// Browsers don't expose EXIF from an <img>, so we grab the first chunk of each
// JPEG ourselves and read the tags out of it. That chunk is all the metadata
// lives in, so a 6 MB photo costs a 64 KB request here. Re-ordering afterwards
// only moves the existing <img> nodes around, which never re-downloads them.

const HEADER_BYTES = 64 * 1024;
const MAX_PARALLEL = 6;

// EXIF tags we care about, in the order we'd rather have them.
const DATE_TIME_ORIGINAL = 0x9003;
const DATE_TIME_DIGITIZED = 0x9004;
const DATE_TIME = 0x0132;
const EXIF_IFD_POINTER = 0x8769;

// Download the front of a file and nothing more.
async function fetchHeader(url) {
  const response = await fetch(url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);

  // A 206 means the server honoured the range and sent us only the slice.
  if (response.status === 206 || !response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }

  // Otherwise it's sending the whole file: read the part we need, then hang up
  // so the rest never comes down the wire.
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < HEADER_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

// Walk the JPEG marker segments looking for the APP1 block that holds EXIF.
// Returns the offset of the TIFF header inside it, or null.
function findTiffHeader(bytes, view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);

    // Padding and standalone markers carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Image data starts here; any EXIF would have come before it.
    if (marker === 0xda || marker === 0xd9) return null;

    const length = view.getUint16(offset + 2);
    if (marker === 0xe1 && offset + 10 <= view.byteLength) {
      const tag = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (tag === 'Exif') return offset + 10;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

// Map of tag number -> offset of its 12-byte directory entry.
function readIfd(view, ifdOffset, little) {
  const entries = new Map();
  if (ifdOffset + 2 > view.byteLength) return entries;

  const count = view.getUint16(ifdOffset, little);
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    entries.set(view.getUint16(entry, little), entry);
  }
  return entries;
}

// ASCII values up to 4 bytes sit inline; longer ones live at an offset.
function readAscii(bytes, view, tiffStart, entry, little) {
  const count = view.getUint32(entry + 4, little);
  const start = count > 4 ? tiffStart + view.getUint32(entry + 8, little) : entry + 8;

  let value = '';
  for (let i = 0; i < count && start + i < bytes.length; i++) {
    const code = bytes[start + i];
    if (!code) break;
    value += String.fromCharCode(code);
  }
  return value;
}

// EXIF dates look like "2011:02:20 21:32:44" and are camera-local time.
function parseExifDate(value) {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (!year) return null; // Some cameras write all zeroes when the clock is unset.

  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readDateTaken(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tiffStart = findTiffHeader(bytes, view);
  if (tiffStart === null || tiffStart + 8 > view.byteLength) return null;

  const byteOrder = view.getUint16(tiffStart);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;
  const little = byteOrder === 0x4949;
  if (view.getUint16(tiffStart + 2, little) !== 0x002a) return null;

  const ifd0 = readIfd(view, tiffStart + view.getUint32(tiffStart + 4, little), little);

  // The capture timestamps hang off the Exif sub-IFD; IFD0's DateTime is the
  // last-modified fallback.
  const pointer = ifd0.get(EXIF_IFD_POINTER);
  const exifIfd = pointer
    ? readIfd(view, tiffStart + view.getUint32(pointer + 8, little), little)
    : new Map();

  const candidates = [
    exifIfd.get(DATE_TIME_ORIGINAL),
    exifIfd.get(DATE_TIME_DIGITIZED),
    ifd0.get(DATE_TIME),
  ];

  for (const entry of candidates) {
    if (entry === undefined) continue;
    const date = parseExifDate(readAscii(bytes, view, tiffStart, entry, little));
    if (date) return date;
  }
  return null;
}

async function dateTakenFor(img) {
  try {
    return readDateTaken(await fetchHeader(img.src));
  } catch {
    return null; // Offline, blocked, or not a JPEG — just leave it undated.
  }
}

// Run the lookups a few at a time so we don't open 35 sockets at once.
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function sortGalleryByDate() {
  const columns = [...document.querySelectorAll('.container .column')];
  if (!columns.length) return;

  const images = columns.flatMap(column => [...column.querySelectorAll('img')]);
  if (!images.length) return;

  const dates = await mapWithLimit(images, MAX_PARALLEL, dateTakenFor);

  const photos = images.map((img, index) => ({ img, date: dates[index], index }));
  if (!photos.some(photo => photo.date)) return; // Nothing readable; leave the page alone.

  // Newest first. Photos we couldn't date keep their authored order at the end.
  photos.sort((a, b) => {
    if (a.date && b.date) return b.date - a.date;
    if (a.date) return -1;
    if (b.date) return 1;
    return a.index - b.index;
  });

  photos.forEach((photo, position) => {
    if (photo.date) {
      const label = formatDate(photo.date);
      photo.img.dataset.date = photo.date.toISOString();
      photo.img.title = label;
      photo.img.alt = photo.img.alt.split('//')[0].trim() + ` // ${label}`;
    }
    // Dealing across the columns keeps the dates reading left-to-right.
    columns[position % columns.length].append(photo.img);
  });
}

sortGalleryByDate();
