// ─── Blank / placeholder detection ────────────────────────────────────────────

const BLANK_TOKENS = new Set([
  '',
  '-',
  '--',
  'na',
  'n/a',
  'nil',
  'null',
  'none',
  'tbd',
  'tbc',
  'not applicable',
  'not available',
  '#n/a',
  '#value!',
  '#ref!',
  'nan',
  'nat',
  'undefined',
]);

/** True for values that mean "no data", including Excel error strings. */
export function isBlank(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'number') return Number.isNaN(raw);
  if (typeof raw === 'string') return BLANK_TOKENS.has(raw.trim().toLowerCase());
  return false;
}

/** Trims and collapses internal whitespace; returns null for blank-ish input. */
export function cleanText(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects overflow like 31 Feb, which Date would silently roll forward.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parses the date formats that actually appear across these two boards and
 * normalises to `YYYY-MM-DD`.
 *
 * Ambiguous slash dates (e.g. `05/06/2025`) are read as DD/MM/YYYY, matching
 * the Indian convention of the source spreadsheets. Monday's own date columns
 * return ISO, so this only affects text-typed date fields.
 */
export function parseISODate(raw: unknown): string | null {
  if (isBlank(raw)) return null;

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? null
      : iso(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  }

  const s = String(raw).trim();

  // 2026-02-26, 2026-02-26 00:00:00, 2026-02-26T00:00:00Z
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]|$)/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  // 26/02/2026, 26-02-2026, 26.02.2026  → DD/MM/YYYY
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) {
    const [, a, b, y] = m;
    // If the first part cannot be a day but the second can, it must be MM/DD.
    if (+a > 12 && +b <= 12) return iso(+y, +b, +a);
    return iso(+y, +b, +a);
  }

  // 26 Feb 2026, 26-Feb-2026, Feb 26 2026, 26 February 2026
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);

  m = s.match(/^([A-Za-z]{3,9})[\s\-](\d{1,2})[\s\-,]+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);

  // Excel serial date numbers, in case a date column was imported as a number.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 60000) {
      const epoch = Date.UTC(1899, 11, 30);
      const dt = new Date(epoch + Math.round(serial) * 86_400_000);
      return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
  }

  return null;
}

/** Month-name text like `Actual Billing Month` → 1-12, else null. */
export function parseMonthName(raw: unknown): number | null {
  const s = cleanText(raw);
  if (!s) return null;
  return MONTHS[s.toLowerCase()] ?? null;
}

// ─── Number parsing ───────────────────────────────────────────────────────────

/**
 * Parses currency/quantity values. Handles Indian digit grouping
 * (`1,23,456.78`), ₹/Rs prefixes, Cr/L/K suffixes, parenthesised negatives,
 * and Monday's JSON-quoted number column values.
 */
export function parseNumber(raw: unknown): number | null {
  if (isBlank(raw)) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim();
  if (s === '') return null;

  // Monday number columns return `value` as a JSON-quoted string: "\"264398.08\""
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  }

  s = s.replace(/[₹$,\s]/g, '').replace(/^rs\.?/i, '');
  if (s === '' || BLANK_TOKENS.has(s.toLowerCase())) return null;

  let multiplier = 1;
  const suffix = s.match(/(cr|crore|crores|lakh|lakhs|lac|l|k|m|mn)$/i);
  if (suffix) {
    const unit = suffix[1].toLowerCase();
    if (unit === 'cr' || unit.startsWith('crore')) multiplier = 10_000_000;
    else if (unit === 'l' || unit.startsWith('lakh') || unit === 'lac') multiplier = 100_000;
    else if (unit === 'k') multiplier = 1_000;
    else if (unit === 'm' || unit === 'mn') multiplier = 1_000_000;
    s = s.slice(0, -suffix[1].length);
  }

  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s) * multiplier;
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Extracts a leading number and its unit from free-text quantities such as
 * `"5360 HA"`, `"2057 Acr"`, `"4"`. Units are NOT converted — hectares and
 * acres are never summed together.
 */
export function parseQuantity(raw: unknown): { value: number | null; unit: string | null } {
  const s = cleanText(raw);
  if (!s) return { value: null, unit: null };
  const m = s.match(/^([\d,]*\.?\d+)\s*([A-Za-z.%]*)$/);
  if (!m) return { value: null, unit: null };
  const value = parseNumber(m[1]);
  const unitRaw = m[2]?.toLowerCase().replace(/\.$/, '') ?? '';
  const unit =
    unitRaw === '' ? null
    : /^(ha|hect|hectare|hectares)$/.test(unitRaw) ? 'hectares'
    : /^(ac|acr|acre|acres)$/.test(unitRaw) ? 'acres'
    : /^(km|kms)$/.test(unitRaw) ? 'km'
    : /^(nos?|units?|qty)$/.test(unitRaw) ? 'units'
    : unitRaw;
  return { value, unit };
}

// ─── Column lookup ────────────────────────────────────────────────────────────

export interface ColumnValueLike {
  id: string;
  title: string;
  text: string | null;
  value: string | null;
}

/** Normalises a column title for tolerant matching against board columns. */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Looks up a column by title, tolerant of the whitespace, casing and
 * punctuation drift introduced by spreadsheet → Monday import.
 * Falls back to a containment match before giving up.
 */
export function getCol(cvs: ColumnValueLike[], title: string): string | null {
  const want = normaliseTitle(title);

  let hit = cvs.find((c) => normaliseTitle(c.title) === want);
  if (!hit) {
    hit = cvs.find((c) => {
      const got = normaliseTitle(c.title);
      return got.includes(want) || want.includes(got);
    });
  }
  if (!hit) return null;

  // Monday returns "" (not null) for empty cells on several column types.
  return cleanText(hit.text);
}

/** Raw JSON `value` payload for a column — used for number columns. */
export function getColRaw(cvs: ColumnValueLike[], title: string): string | null {
  const want = normaliseTitle(title);
  const hit = cvs.find((c) => normaliseTitle(c.title) === want);
  return hit?.value ?? null;
}

/**
 * True only when a row carries no information at all — no name and no populated
 * cell. Such rows are import artefacts.
 *
 * A row missing only its NAME is not empty: in the Work Orders sheet one row has
 * a blank deal name but a real serial number, sector and ₹10.36 L contract value.
 * Dropping it would quietly delete revenue, so nameless-but-populated rows are
 * kept and flagged instead.
 */
export function isEmptyRow(name: string | null, cvs: ColumnValueLike[]): boolean {
  if (cleanText(name) !== null) return false;
  return cvs.every((c) => cleanText(c.text) === null);
}

/** Number columns: prefer `text`, fall back to the JSON `value` payload. */
export function getNumberCol(cvs: ColumnValueLike[], title: string): number | null {
  const fromText = parseNumber(getCol(cvs, title));
  if (fromText !== null) return fromText;
  return parseNumber(getColRaw(cvs, title));
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Indian currency notation: ₹1.23 Cr / ₹4.56 L / ₹78,900. */
export function formatINR(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${sign}₹${(abs / 10_000_000).toFixed(2)} Cr`;
  if (abs >= 100_000) return `${sign}₹${(abs / 100_000).toFixed(2)} L`;
  return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
}
