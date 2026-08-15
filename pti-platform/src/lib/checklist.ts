import type { ChecklistItem } from './types'

export const DEFAULT_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Trailer Exterior
  { id: 'ext-doors',   category: 'Trailer Exterior', label: 'Rear Doors & Seals',               mandatory: true },
  { id: 'ext-roof',    category: 'Trailer Exterior', label: 'Roof & Sides (No Damage)',          mandatory: true },
  { id: 'ext-frame',   category: 'Trailer Exterior', label: 'Frame & Undercarriage',             mandatory: true },
  { id: 'ext-floor',   category: 'Trailer Exterior', label: 'Floor Condition (No Soft Spots)',   mandatory: true },
  { id: 'ext-landing', category: 'Trailer Exterior', label: 'Landing Gear (Retracted & Secure)', mandatory: true },

  // Lights & Reflectors
  { id: 'lt-tail',       category: 'Lights & Reflectors', label: 'Tail Lights',                  mandatory: true },
  { id: 'lt-brake',      category: 'Lights & Reflectors', label: 'Brake Lights',                 mandatory: true },
  { id: 'lt-turn',       category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)',  mandatory: true },
  { id: 'lt-clearance',  category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',   mandatory: true },
  { id: 'lt-reflectors', category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',       mandatory: true },

  // Coupling & Connection
  { id: 'coup-kingpin',    category: 'Coupling & Connection', label: 'King Pin Secure',                     mandatory: true },
  { id: 'coup-gladhands',  category: 'Coupling & Connection', label: 'Glad Hands Connected (Air Lines)',    mandatory: true },
  { id: 'coup-electrical', category: 'Coupling & Connection', label: 'Electrical Plug (7-Pin) Connected',   mandatory: true },
  { id: 'coup-safety',     category: 'Coupling & Connection', label: 'Safety Chains / Cables Secured',      mandatory: true },

  // Cargo & Seals
  { id: 'cargo-doors',  category: 'Cargo & Seals', label: 'Cargo Doors Locked & Latched', mandatory: true },
  { id: 'cargo-seal',   category: 'Cargo & Seals', label: 'Seal Intact (if applicable)',   mandatory: false },
  { id: 'cargo-secure', category: 'Cargo & Seals', label: 'Cargo Properly Secured',        mandatory: false },
]

export const TIRE_POSITIONS = [
  'Axle 1 — Left Outer',
  'Axle 1 — Left Inner',
  'Axle 1 — Right Inner',
  'Axle 1 — Right Outer',
  'Axle 2 — Left Outer',
  'Axle 2 — Left Inner',
  'Axle 2 — Right Inner',
  'Axle 2 — Right Outer',
]

export function buildChecklist(): ChecklistItem[] {
  return DEFAULT_CHECKLIST.map((item) => ({
    ...item,
    status: 'PENDING' as const,
    notes: '',
  }))
}

export function getChecklistCategories(items: ChecklistItem[]): string[] {
  return [...new Set(items.map((i) => i.category))]
}

export function getFailCount(items: ChecklistItem[]): number {
  return items.filter((i) => i.status === 'FAIL').length
}

export function isChecklistComplete(items: ChecklistItem[]): boolean {
  return items.filter((i) => i.mandatory).every((i) => i.status !== 'PENDING')
}
