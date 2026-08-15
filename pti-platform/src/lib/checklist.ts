import type { ChecklistItem } from './types'

export const DEFAULT_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Trailer Exterior
  { id: 'ext-doors',   category: 'Trailer Exterior', label: 'Rear Doors & Seals',               mandatory: true },
  { id: 'ext-roof',    category: 'Trailer Exterior', label: 'Roof & Sides (No Damage)',          mandatory: true },
  { id: 'ext-frame',   category: 'Trailer Exterior', label: 'Frame & Undercarriage',             mandatory: true },
  { id: 'ext-floor',   category: 'Trailer Exterior', label: 'Floor Condition (No Soft Spots)',   mandatory: true },
  { id: 'ext-landing',  category: 'Trailer Exterior', label: 'Landing Gear (Retracted & Secure)', mandatory: true },
  { id: 'ext-plate',   category: 'Trailer Exterior', label: 'License Plate (Visible & Secure)',   mandatory: true },
  { id: 'ext-mudflaps', category: 'Trailer Exterior', label: 'Mud Flaps (Installed & Intact)',     mandatory: true },

  // Lights & Reflectors
  { id: 'lt-tail',       category: 'Lights & Reflectors', label: 'Tail Lights',                  mandatory: true },
  { id: 'lt-brake',      category: 'Lights & Reflectors', label: 'Brake Lights',                 mandatory: true },
  { id: 'lt-turn',       category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)',  mandatory: true },
  { id: 'lt-clearance',  category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',   mandatory: true },
  { id: 'lt-reflectors', category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',       mandatory: true },
  { id: 'lt-abs',        category: 'Lights & Reflectors', label: 'ABS Light (Off When Running)', mandatory: true },

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
