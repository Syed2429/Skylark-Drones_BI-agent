/**
 * Converts the two source spreadsheets into a Monday.com-shaped JSON fixture.
 *
 * This exists ONLY so the agent can be exercised end-to-end before the Monday
 * boards are provisioned (DATA_SOURCE=mock). The shipped default is
 * DATA_SOURCE=monday — the agent always queries Monday.com live in the hosted
 * prototype. Nothing downstream of the data-source boundary knows which one
 * it is talking to.
 *
 *   npm run seed
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// `xlsx` is CommonJS and its filesystem helpers are only wired up on the CJS
// export, so require it rather than using an ESM namespace import.
const XLSX = createRequire(import.meta.url)('xlsx');

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const SOURCE_DIR = resolve(PROJECT_ROOT, '..');
const OUT_FILE = join(PROJECT_ROOT, 'lib', 'data', 'mock-boards.json');

const BOARDS = [
  {
    key: 'deals',
    file: 'Deal funnel Data.xlsx',
    sheet: 'Deal tracker',
    boardName: 'Deals Pipeline',
    nameColumn: 'Deal Name',
  },
  {
    key: 'workOrders',
    file: 'Work_Order_Tracker Data.xlsx',
    sheet: 'work order tracker',
    boardName: 'Work Orders',
    nameColumn: 'Deal name masked',
  },
];

/**
 * Locates the header row rather than hardcoding it.
 *
 * As shipped, the Work Orders sheet has a blank row 0 with its header on row 1,
 * while Deals has its header on row 0. Detecting it keeps this working whether
 * or not that blank row has since been deleted by hand.
 */
function findHeaderRow(matrix, nameColumn, file) {
  const target = nameColumn.trim().toLowerCase();

  for (let i = 0; i < Math.min(matrix.length, 10); i += 1) {
    const first = String(matrix[i]?.[0] ?? '').trim().toLowerCase();
    if (first === target) return i;
  }

  for (let i = 0; i < Math.min(matrix.length, 10); i += 1) {
    if ((matrix[i] ?? []).some((c) => c !== null && String(c).trim() !== '')) {
      console.warn(
        `  ! No "${nameColumn}" header found in ${file}; assuming row ${i + 1} is the header.`
      );
      return i;
    }
  }

  console.error(`  ${file} appears to be empty.`);
  process.exit(1);
}

const DATE_HINTS = /date$/i;

function toText(value, title) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number') {
    // Monday renders date columns as YYYY-MM-DD; mirror that for date columns
    // that survived as Excel serial numbers.
    if (DATE_HINTS.test(title.trim()) && value > 20000 && value < 60000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
      return dt.toISOString().slice(0, 10);
    }
    return String(value);
  }

  const s = String(value).trim();
  return s === '' ? null : s;
}

function inferType(title) {
  const t = title.toLowerCase();
  if (DATE_HINTS.test(title.trim())) return 'date';
  if (/amount|value|quantity|balance|masked deal/.test(t)) return 'numbers';
  if (/status|stage|probability|sector|nature|type|priority/.test(t)) return 'status';
  return 'text';
}

function columnId(title, index) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return `${slug || 'col'}__${index}`;
}

const output = { generatedAt: new Date().toISOString(), boards: {} };

for (const board of BOARDS) {
  const path = join(SOURCE_DIR, board.file);
  if (!existsSync(path)) {
    console.error(`\n  Missing source file: ${path}`);
    console.error(`  Expected the two .xlsx files one level above the project root.\n`);
    process.exit(1);
  }

  const wb = XLSX.readFile(path, { cellDates: true });
  const ws = wb.Sheets[board.sheet];
  if (!ws) {
    console.error(`  Sheet "${board.sheet}" not found in ${board.file}.`);
    console.error(`  Available sheets: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }

  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, cellDates: true, defval: null });
  const headerRow = findHeaderRow(matrix, board.nameColumn, board.file);
  const header = matrix[headerRow].map((h, i) => (h === null ? `Column ${i + 1}` : String(h).trim()));
  const rows = matrix.slice(headerRow + 1);

  const nameIdx = header.findIndex((h) => h === board.nameColumn);
  if (nameIdx === -1) {
    console.error(`  Name column "${board.nameColumn}" not found in ${board.file}.`);
    process.exit(1);
  }

  const columns = header
    .map((title, i) => ({ id: columnId(title, i), title, type: inferType(title), index: i }))
    .filter((c) => c.index !== nameIdx);

  const items = rows.map((row, r) => ({
    id: `${board.key}-${r + 1}`,
    // Monday promotes the first column to the item name.
    name: toText(row?.[nameIdx] ?? null, board.nameColumn) ?? '',
    column_values: columns.map((c) => {
      const text = toText(row?.[c.index] ?? null, c.title);
      return {
        id: c.id,
        title: c.title,
        type: c.type,
        text,
        value: text === null ? null : JSON.stringify(text),
      };
    }),
  }));

  output.boards[board.key] = {
    meta: {
      id: `mock-${board.key}`,
      name: board.boardName,
      columns: [
        { id: 'name', title: board.nameColumn, type: 'name' },
        ...columns.map(({ id, title, type }) => ({ id, title, type })),
      ],
    },
    items,
  };

  console.log(`  ${board.boardName.padEnd(16)} ${items.length} items, ${columns.length + 1} columns`);
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
console.log(`\n  Wrote ${OUT_FILE}\n`);
