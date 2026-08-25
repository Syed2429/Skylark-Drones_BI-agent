/**
 * Canonical vocabularies for both boards, plus the business-language → data-value
 * mappings the agent needs to answer questions the way a founder asks them.
 */

// ─── Sectors ──────────────────────────────────────────────────────────────────

/** Every sector value that exists across the two boards. */
export const CANONICAL_SECTORS = [
  'Renewables',
  'Mining',
  'Railways',
  'Powerline',
  'Construction',
  'Others',
  'DSP',
  'Tender',
  'Manufacturing',
  'Security and Surveillance',
  'Aviation',
] as const;

export type Sector = (typeof CANONICAL_SECTORS)[number];

const SECTOR_ALIASES: Record<string, Sector> = {
  renewables: 'Renewables',
  renewable: 'Renewables',
  'renewable energy': 'Renewables',
  solar: 'Renewables',
  wind: 'Renewables',
  mining: 'Mining',
  mine: 'Mining',
  mines: 'Mining',
  railways: 'Railways',
  railway: 'Railways',
  rail: 'Railways',
  rails: 'Railways',
  powerline: 'Powerline',
  'power line': 'Powerline',
  powerlines: 'Powerline',
  transmission: 'Powerline',
  construction: 'Construction',
  infra: 'Construction',
  infrastructure: 'Construction',
  dsp: 'DSP',
  tender: 'Tender',
  tenders: 'Tender',
  manufacturing: 'Manufacturing',
  'security and surveillance': 'Security and Surveillance',
  security: 'Security and Surveillance',
  surveillance: 'Security and Surveillance',
  aviation: 'Aviation',
  others: 'Others',
  other: 'Others',
  misc: 'Others',
};

/**
 * Business phrases that map to a GROUP of sectors rather than one value.
 *
 * "Energy" is the motivating case: the assignment's own sample question asks
 * about the "energy sector", but no board has a sector literally called that.
 * Renewables and Powerline together are the energy business.
 */
export const SECTOR_GROUPS: Record<string, { sectors: Sector[]; note: string }> = {
  energy: {
    sectors: ['Renewables', 'Powerline'],
    note: 'No sector is literally labelled "Energy". Interpreted as Renewables + Powerline (generation + transmission).',
  },
  power: {
    sectors: ['Renewables', 'Powerline'],
    note: 'Interpreted as Renewables + Powerline.',
  },
  'clean energy': {
    sectors: ['Renewables'],
    note: 'Interpreted as Renewables only.',
  },
  'green energy': {
    sectors: ['Renewables'],
    note: 'Interpreted as Renewables only.',
  },
  utilities: {
    sectors: ['Powerline', 'Renewables'],
    note: 'Interpreted as Powerline + Renewables.',
  },
  infrastructure: {
    sectors: ['Construction', 'Railways', 'Powerline'],
    note: 'Interpreted as Construction + Railways + Powerline.',
  },
  transport: {
    sectors: ['Railways'],
    note: 'Railways is the only transport sector in the data.',
  },
  resources: {
    sectors: ['Mining'],
    note: 'Interpreted as Mining.',
  },
};

export function normaliseSector(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return SECTOR_ALIASES[key] ?? raw.replace(/\s+/g, ' ').trim();
}

/**
 * Resolves a user-supplied sector term into concrete sector values.
 * Returns the group note so the agent can state its interpretation out loud.
 */
export function resolveSectorTerm(term: string): { sectors: string[]; note: string | null } {
  const key = term.toLowerCase().replace(/\s+/g, ' ').trim();

  const group = SECTOR_GROUPS[key];
  if (group) return { sectors: [...group.sectors], note: group.note };

  const alias = SECTOR_ALIASES[key];
  if (alias) return { sectors: [alias], note: null };

  const exact = CANONICAL_SECTORS.find((s) => s.toLowerCase() === key);
  if (exact) return { sectors: [exact], note: null };

  const partial = CANONICAL_SECTORS.filter(
    (s) => s.toLowerCase().includes(key) || key.includes(s.toLowerCase())
  );
  if (partial.length) return { sectors: [...partial], note: null };

  return { sectors: [], note: `No sector matches "${term}".` };
}

// ─── Deal stages ──────────────────────────────────────────────────────────────

/**
 * The funnel in order. `Project Completed` carries no letter prefix in the
 * source data but sits after `K. Amount Accrued` in practice.
 */
export const DEAL_STAGE_ORDER: string[] = [
  'A. Lead Generated',
  'B. Sales Qualified Leads',
  'C. Demo Done',
  'D. Feasibility',
  'E. Proposal/Commercials Sent',
  'F. Negotiations',
  'G. Project Won',
  'H. Work Order Received',
  'I. POC',
  'J. Invoice sent',
  'K. Amount Accrued',
  'Project Completed',
  'L. Project Lost',
  'M. Projects On Hold',
  'N. Not relevant at the moment',
  'O. Not Relevant at all',
];

/** Stages that represent an active, still-winnable opportunity. */
export const ACTIVE_FUNNEL_STAGES = new Set([
  'A. Lead Generated',
  'B. Sales Qualified Leads',
  'C. Demo Done',
  'D. Feasibility',
  'E. Proposal/Commercials Sent',
  'F. Negotiations',
  'I. POC',
]);

/** Stages meaning the deal is over, won or lost. */
export const TERMINAL_STAGES = new Set([
  'G. Project Won',
  'H. Work Order Received',
  'J. Invoice sent',
  'K. Amount Accrued',
  'Project Completed',
  'L. Project Lost',
  'N. Not relevant at the moment',
  'O. Not Relevant at all',
]);

export function parseDealStage(stage: string | null): {
  letter: string | null;
  label: string | null;
} {
  if (!stage) return { letter: null, label: null };
  const m = stage.match(/^([A-Z])\.\s*(.+)$/);
  if (m) return { letter: m[1], label: m[2].trim() };
  return { letter: null, label: stage.trim() };
}

export function dealStageIndex(stage: string | null): number {
  if (!stage) return -1;
  return DEAL_STAGE_ORDER.indexOf(stage);
}

// ─── Deal status ──────────────────────────────────────────────────────────────

export type DealStatusValue = 'Open' | 'Won' | 'Dead' | 'On Hold';

const DEAL_STATUS_ALIASES: Record<string, DealStatusValue> = {
  open: 'Open',
  active: 'Open',
  live: 'Open',
  won: 'Won',
  win: 'Won',
  'closed won': 'Won',
  dead: 'Dead',
  lost: 'Dead',
  'closed lost': 'Dead',
  'on hold': 'On Hold',
  hold: 'On Hold',
  onhold: 'On Hold',
  paused: 'On Hold',
};

export function normaliseDealStatus(raw: string | null): DealStatusValue | null {
  if (!raw) return null;
  return DEAL_STATUS_ALIASES[raw.toLowerCase().replace(/\s+/g, ' ').trim()] ?? null;
}

// ─── Work order execution status ──────────────────────────────────────────────

/**
 * Canonicalises the seven execution statuses in the source data.
 * `Executed until current month` is a recurring-contract state, not a synonym
 * for Completed — it is kept distinct as `Ongoing (Recurring)`.
 */
const EXEC_STATUS_ALIASES: Record<string, string> = {
  completed: 'Completed',
  complete: 'Completed',
  ongoing: 'Ongoing',
  'in progress': 'Ongoing',
  'executed until current month': 'Ongoing (Recurring)',
  'not started': 'Not Started',
  notstarted: 'Not Started',
  'pause / struck': 'Paused/Stuck',
  'pause/struck': 'Paused/Stuck',
  paused: 'Paused/Stuck',
  struck: 'Paused/Stuck',
  stuck: 'Paused/Stuck',
  'partial completed': 'Partially Completed',
  'partially completed': 'Partially Completed',
  'details pending from client': 'Pending Client Input',
};

export function normaliseExecutionStatus(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return EXEC_STATUS_ALIASES[key] ?? raw.replace(/\s+/g, ' ').trim();
}

/** Execution states where work is still owed to the customer. */
export const IN_FLIGHT_EXECUTION_STATUSES = new Set([
  'Ongoing',
  'Ongoing (Recurring)',
  'Not Started',
  'Partially Completed',
  'Paused/Stuck',
  'Pending Client Input',
]);

// ─── Invoice / billing status ─────────────────────────────────────────────────

/**
 * Normalises billing + invoice statuses. Notably fixes the `BIlled` typo and
 * collapses the per-visit variants (`Billed- Visit 7`) onto `Billed`.
 */
export function normaliseBillingStatus(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  if (/^billed\b/.test(key) || key === 'billed') return 'Billed';
  if (key === 'fully billed') return 'Fully Billed';
  if (key === 'partially billed' || key === 'partial billed') return 'Partially Billed';
  if (key === 'not billed yet' || key === 'not billed') return 'Not Billed Yet';
  if (key === 'not billable') return 'Not Billable';
  if (key === 'update required') return 'Update Required';
  if (key === 'stuck') return 'Stuck';

  return raw.replace(/\s+/g, ' ').trim();
}

/** Columns that are 100% empty across all rows in the source Work Orders file. */
export const ALWAYS_EMPTY_WO_COLUMNS = [
  'Expected Billing Month',
  'Actual Collection Month',
  'Collection status',
  'Collection Date',
];
