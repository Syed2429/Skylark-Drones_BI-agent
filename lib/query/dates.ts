/**
 * Period resolution.
 *
 * Skylark is an Indian company, so an unqualified "quarter" or "year" is read
 * as the Indian fiscal calendar (1 April – 31 March). FY26-27 means
 * Apr 2026 – Mar 2027; Q1 is Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
 *
 * Every resolution returns a `note` explaining the interpretation, so the agent
 * can state its assumption rather than silently guessing on the founder's behalf.
 */

export interface Period {
  start: string; // inclusive, YYYY-MM-DD
  end: string; // inclusive, YYYY-MM-DD
  label: string;
  basis: 'fiscal' | 'calendar' | 'rolling' | 'explicit';
  note: string | null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parts(isoDate: string): { y: number; m: number; d: number } {
  const [y, m, d] = isoDate.split('-').map(Number);
  return { y, m, d };
}

/** Fiscal year that a date falls in, identified by its starting calendar year. */
export function fiscalYearOf(isoDate: string): number {
  const { y, m } = parts(isoDate);
  return m >= 4 ? y : y - 1;
}

/** Fiscal quarter 1-4 for a date (Q1 = Apr–Jun). */
export function fiscalQuarterOf(isoDate: string): number {
  const { m } = parts(isoDate);
  return Math.floor(((m - 4 + 12) % 12) / 3) + 1;
}

export function fiscalYearLabel(fyStartYear: number): string {
  return `FY${String(fyStartYear).slice(2)}-${String(fyStartYear + 1).slice(2)}`;
}

export function fiscalQuarterRange(fyStartYear: number, q: number): Period {
  const startMonth = ((q - 1) * 3 + 4 - 1) % 12 + 1; // Q1→4, Q2→7, Q3→10, Q4→1
  const startYear = startMonth >= 4 ? fyStartYear : fyStartYear + 1;
  const endMonthAbs = startMonth + 2;
  const endMonth = ((endMonthAbs - 1) % 12) + 1;
  const endYear = endMonthAbs > 12 ? startYear + 1 : startYear;

  return {
    start: ymd(startYear, startMonth, 1),
    end: ymd(endYear, endMonth, lastDayOfMonth(endYear, endMonth)),
    label: `Q${q} ${fiscalYearLabel(fyStartYear)}`,
    basis: 'fiscal',
    note: `Indian fiscal calendar: Q${q} of ${fiscalYearLabel(fyStartYear)} runs ${ymd(startYear, startMonth, 1)} to ${ymd(endYear, endMonth, lastDayOfMonth(endYear, endMonth))}.`,
  };
}

export function fiscalYearRange(fyStartYear: number): Period {
  return {
    start: ymd(fyStartYear, 4, 1),
    end: ymd(fyStartYear + 1, 3, 31),
    label: fiscalYearLabel(fyStartYear),
    basis: 'fiscal',
    note: `Indian fiscal year: ${fiscalYearLabel(fyStartYear)} runs 1 Apr ${fyStartYear} to 31 Mar ${fyStartYear + 1}.`,
  };
}

export function calendarQuarterRange(year: number, q: number): Period {
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    start: ymd(year, startMonth, 1),
    end: ymd(year, endMonth, lastDayOfMonth(year, endMonth)),
    label: `Q${q} ${year} (calendar)`,
    basis: 'calendar',
    note: `Calendar quarter, as explicitly requested.`,
  };
}

function addQuarters(fy: number, q: number, delta: number): { fy: number; q: number } {
  const abs = fy * 4 + (q - 1) + delta;
  return { fy: Math.floor(abs / 4), q: (abs % 4) + 1 };
}

const SINGLE_YEAR_FY_NOTE =
  'A single-year "FYnn" is read by its ENDING year, per Indian convention — say "FY25-26" if you meant the year starting then.';

/**
 * Converts the year token in an "FY…" expression to the fiscal year's STARTING
 * calendar year.
 *
 * "FY25-26" states both ends, so 25 is the start. A bare "FY25" names the year
 * by the calendar year it ENDS in — the standard Indian reading — so it means
 * Apr 2024 – Mar 2025 and the start year is 2024.
 */
function fyStartYearFrom(token: string, spansTwoYears: boolean): number {
  const year = token.length === 2 ? 2000 + Number(token) : Number(token);
  return spansTwoYears ? year : year - 1;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Resolves a natural-language period into a concrete date range.
 * Returns null when the term is not recognised, so the caller can ask the user
 * instead of inventing a range.
 */
export function resolvePeriod(term: string, now: string = today()): Period | null {
  const t = term.toLowerCase().replace(/\s+/g, ' ').trim();
  const nowFy = fiscalYearOf(now);
  const nowFq = fiscalQuarterOf(now);
  const { y: nowY, m: nowM } = parts(now);

  // Explicit range: 2025-04-01..2025-06-30
  const range = t.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|–|-)\s*(\d{4}-\d{2}-\d{2})$/);
  if (range) {
    return {
      start: range[1],
      end: range[2],
      label: `${range[1]} to ${range[2]}`,
      basis: 'explicit',
      note: null,
    };
  }

  if (t === 'all time' || t === 'all' || t === 'ever' || t === 'lifetime') {
    return { start: '1900-01-01', end: '2100-12-31', label: 'all time', basis: 'explicit', note: null };
  }

  // this / last / next quarter → fiscal by default
  if (/^(this|current) (quarter|qtr)$/.test(t)) return fiscalQuarterRange(nowFy, nowFq);
  if (/^(last|previous|prior) (quarter|qtr)$/.test(t)) {
    const p = addQuarters(nowFy, nowFq, -1);
    return fiscalQuarterRange(p.fy, p.q);
  }
  if (/^(next|coming|upcoming) (quarter|qtr)$/.test(t)) {
    const p = addQuarters(nowFy, nowFq, 1);
    return fiscalQuarterRange(p.fy, p.q);
  }

  // Q3 FY26 / Q3 FY25-26 / FY26 Q3
  let m = t.match(/q([1-4])\s*(?:of\s*)?fy\s*(\d{2}|\d{4})(\s*-\s*\d{2,4})?/)
    ?? t.match(/fy\s*(\d{2}|\d{4})(\s*-\s*\d{2,4})?\s*q([1-4])/);
  if (m) {
    const isQFirst = /^q/.test(m[0]);
    const q = Number(isQFirst ? m[1] : m[3]);
    const yRaw = isQFirst ? m[2] : m[1];
    const spanned = Boolean(isQFirst ? m[3] : m[2]);
    const period = fiscalQuarterRange(fyStartYearFrom(yRaw, spanned), q);
    return spanned ? period : { ...period, note: `${period.note} ${SINGLE_YEAR_FY_NOTE}` };
  }

  // FY26 / FY2026 / FY25-26
  m = t.match(/^fy\s*(\d{2}|\d{4})(?:\s*-\s*(\d{2,4}))?$/);
  if (m) {
    const spanned = Boolean(m[2]);
    const period = fiscalYearRange(fyStartYearFrom(m[1], spanned));
    return spanned ? period : { ...period, note: `${period.note} ${SINGLE_YEAR_FY_NOTE}` };
  }

  if (/^(this|current) (fiscal|financial) year$/.test(t) || t === 'this fy' || t === 'fytd') {
    return fiscalYearRange(nowFy);
  }
  if (/^(last|previous) (fiscal|financial) year$/.test(t) || t === 'last fy') {
    return fiscalYearRange(nowFy - 1);
  }

  // Calendar quarter: Q3 2025
  m = t.match(/^q([1-4])\s*(?:of\s*)?(\d{4})$/);
  if (m) return calendarQuarterRange(Number(m[2]), Number(m[1]));

  // Calendar year: 2025, "calendar 2025"
  m = t.match(/^(?:calendar\s*)?(\d{4})$/);
  if (m) {
    const y = Number(m[1]);
    return {
      start: ymd(y, 1, 1),
      end: ymd(y, 12, 31),
      label: `${y} (calendar year)`,
      basis: 'calendar',
      note: 'Read as a calendar year because a bare year was given. Say "FY26" for the fiscal year.',
    };
  }

  if (/^(this|current) year$/.test(t)) {
    return {
      start: ymd(nowY, 1, 1),
      end: ymd(nowY, 12, 31),
      label: `${nowY} (calendar year)`,
      basis: 'calendar',
      note: null,
    };
  }

  // Months: "this month", "last month", "March 2026", "March"
  if (/^(this|current) month$/.test(t)) {
    return {
      start: ymd(nowY, nowM, 1),
      end: ymd(nowY, nowM, lastDayOfMonth(nowY, nowM)),
      label: `${now.slice(0, 7)}`,
      basis: 'calendar',
      note: null,
    };
  }
  if (/^(last|previous) month$/.test(t)) {
    const y = nowM === 1 ? nowY - 1 : nowY;
    const mo = nowM === 1 ? 12 : nowM - 1;
    return {
      start: ymd(y, mo, 1),
      end: ymd(y, mo, lastDayOfMonth(y, mo)),
      label: `${y}-${pad(mo)}`,
      basis: 'calendar',
      note: null,
    };
  }
  m = t.match(/^([a-z]{3,9})\s*(\d{4})$/);
  if (m && MONTH_NAMES[m[1]]) {
    const mo = MONTH_NAMES[m[1]];
    const y = Number(m[2]);
    return {
      start: ymd(y, mo, 1),
      end: ymd(y, mo, lastDayOfMonth(y, mo)),
      label: `${y}-${pad(mo)}`,
      basis: 'calendar',
      note: null,
    };
  }

  // Rolling windows: "last 90 days", "next 60 days"
  m = t.match(/^(last|past|next|coming)\s*(\d{1,4})\s*(day|days|week|weeks|month|months)$/);
  if (m) {
    const n = Number(m[2]);
    const unitDays = m[3].startsWith('week') ? 7 : m[3].startsWith('month') ? 30 : 1;
    const deltaDays = n * unitDays;
    const nowMs = Date.parse(`${now}T00:00:00Z`);
    const other = new Date(
      nowMs + (m[1] === 'next' || m[1] === 'coming' ? deltaDays : -deltaDays) * 86_400_000
    )
      .toISOString()
      .slice(0, 10);
    const forward = m[1] === 'next' || m[1] === 'coming';
    return {
      start: forward ? now : other,
      end: forward ? other : now,
      label: `${m[1]} ${n} ${m[3]}`,
      basis: 'rolling',
      note: `Rolling window relative to ${now}.`,
    };
  }

  if (t === 'ytd' || t === 'year to date') {
    return {
      start: ymd(nowY, 1, 1),
      end: now,
      label: `${nowY} year to date`,
      basis: 'calendar',
      note: null,
    };
  }

  return null;
}

export function isWithin(dateIso: string | null, period: Period): boolean {
  if (!dateIso) return false;
  return dateIso >= period.start && dateIso <= period.end;
}
