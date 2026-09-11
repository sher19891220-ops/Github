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

// ─────────────────────────────────────────────────────────────
// TRUCK INSPECTION CHECKLIST
// The full tractor inspection: documents, interior, exterior.
// Distinct from the trailer PICKUP/DROP_OFF checklist above.
// ─────────────────────────────────────────────────────────────

export const TRUCK_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Truck Stickers & Papers
  { id: 'doc-nyhut',      category: 'Stickers & Papers', label: 'NY HUT Sticker',     mandatory: true },
  { id: 'doc-ifta',       category: 'Stickers & Papers', label: 'IFTA Sticker',       mandatory: true },
  { id: 'doc-dot',        category: 'Stickers & Papers', label: 'DOT',                mandatory: true },
  { id: 'doc-reg',        category: 'Stickers & Papers', label: 'Registration',       mandatory: true },
  { id: 'doc-folder',     category: 'Stickers & Papers', label: 'Truck Folder',       mandatory: true },
  { id: 'doc-plate',      category: 'Stickers & Papers', label: 'Plate Number',       mandatory: true },
  { id: 'doc-eld',        category: 'Stickers & Papers', label: 'ELD Stickers',       mandatory: true },
  { id: 'doc-inspection', category: 'Stickers & Papers', label: 'Truck Inspection',   mandatory: true },

  // Interior
  { id: 'int-clean',    category: 'Interior', label: 'Cleanliness',           mandatory: true },
  { id: 'int-dash',     category: 'Interior', label: 'Dashboard',             mandatory: true },
  { id: 'int-lights',   category: 'Interior', label: 'Interior Lights',       mandatory: true },
  { id: 'int-latches',  category: 'Interior', label: 'Cabin Latches',         mandatory: true },
  { id: 'int-camera',   category: 'Interior', label: 'Camera System',         mandatory: true },
  { id: 'int-eld',      category: 'Interior', label: 'ELD System',            mandatory: true },
  { id: 'int-tablet',   category: 'Interior', label: 'Tablet Present',        mandatory: true },
  { id: 'int-gps',      category: 'Interior', label: 'GPS',                   mandatory: true },
  { id: 'int-fuelcard', category: 'Interior', label: 'Fuel Card',             mandatory: true },
  { id: 'int-mattress', category: 'Interior', label: 'Mattress',              mandatory: false },
  { id: 'int-inverter', category: 'Interior', label: 'Power Inverter',        mandatory: false },
  { id: 'int-fridge',   category: 'Interior', label: 'Fridge',                mandatory: false },
  { id: 'int-micro',    category: 'Interior', label: 'Microwave',             mandatory: false },
  { id: 'int-apu',      category: 'Interior', label: 'APU',                   mandatory: false },
  { id: 'int-heater',   category: 'Interior', label: 'Heater',                mandatory: true },
  { id: 'int-wipers',   category: 'Interior', label: 'Wipers',                mandatory: true },
  { id: 'int-wshield',  category: 'Interior', label: 'Windshield',            mandatory: true },
  { id: 'int-horns',    category: 'Interior', label: 'Horns',                 mandatory: true },
  { id: 'int-mirrorsw', category: 'Interior', label: 'Mirror Control Switch', mandatory: true },
  { id: 'int-extng',    category: 'Interior', label: 'Fire Extinguisher',     mandatory: true },
  { id: 'int-triangles',category: 'Interior', label: 'Emergency Triangles',   mandatory: true },
  { id: 'int-speedlim', category: 'Interior', label: 'Speed Limiter',         mandatory: true },

  // Exterior
  { id: 'tex-clean',     category: 'Exterior', label: 'Cleanliness',                   mandatory: true },
  { id: 'tex-airleaks',  category: 'Exterior', label: 'No Air Leaks',                  mandatory: true },
  { id: 'tex-plate',     category: 'Exterior', label: 'Plate Number Intact & Visible', mandatory: true },
  { id: 'tex-lights',    category: 'Exterior', label: 'Lights',                        mandatory: true },
  { id: 'tex-hood',      category: 'Exterior', label: 'Hood Operates',                 mandatory: true },
  { id: 'tex-fluids',    category: 'Exterior', label: 'Fluids',                        mandatory: true },
  { id: 'tex-noleaks',   category: 'Exterior', label: 'No Leaks',                      mandatory: true },
  { id: 'tex-engine',    category: 'Exterior', label: 'Engine Compartment',            mandatory: true },
  { id: 'tex-susp',      category: 'Exterior', label: 'Suspension Components',         mandatory: true },
  { id: 'tex-steertire', category: 'Exterior', label: 'Steer Tires',                   mandatory: true },
  { id: 'tex-drivetire', category: 'Exterior', label: 'Drive Tires',                   mandatory: true },
  { id: 'tex-brakes',    category: 'Exterior', label: 'Brakes Checked',                mandatory: true },
  { id: 'tex-airhoses',  category: 'Exterior', label: 'Three-in-One Air Hoses Secure', mandatory: true },
  { id: 'tex-loose',     category: 'Exterior', label: 'No Loose Hanging Parts',        mandatory: true },
  { id: 'tex-mudflap',   category: 'Exterior', label: 'Mudflap Secure',                mandatory: true },
  { id: 'tex-deerguard', category: 'Exterior', label: 'Deer Guard',                    mandatory: false },
  { id: 'tex-chains',    category: 'Exterior', label: 'Chains Counted',                mandatory: false },
  { id: 'tex-straps',    category: 'Exterior', label: 'Straps',                        mandatory: false },
  { id: 'tex-toolkit',   category: 'Exterior', label: 'Tool Kit',                      mandatory: false },
  { id: 'tex-inflater',  category: 'Exterior', label: 'Air Hose Inflater',             mandatory: false },
  { id: 'tex-jumper',    category: 'Exterior', label: 'Jumper Cables',                 mandatory: false },
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

// Truck inspections check the tractor's own tires, not trailer axles.
export const TRUCK_TIRE_POSITIONS = [
  'Steer — Left',
  'Steer — Right',
  'Drive Axle 1 — Left Outer',
  'Drive Axle 1 — Left Inner',
  'Drive Axle 1 — Right Inner',
  'Drive Axle 1 — Right Outer',
  'Drive Axle 2 — Left Outer',
  'Drive Axle 2 — Left Inner',
  'Drive Axle 2 — Right Inner',
  'Drive Axle 2 — Right Outer',
]

export function buildChecklist(type?: string): ChecklistItem[] {
  const source = type === 'TRUCK' ? TRUCK_CHECKLIST : DEFAULT_CHECKLIST
  return source.map((item) => ({
    ...item,
    status: 'PENDING' as const,
    notes: '',
  }))
}

export function getTirePositions(type?: string): string[] {
  return type === 'TRUCK' ? TRUCK_TIRE_POSITIONS : TIRE_POSITIONS
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

// Truck inspection support: TRUCK type, 51-item checklist, tractor photo angles.
