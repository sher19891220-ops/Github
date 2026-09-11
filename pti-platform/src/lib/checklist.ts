import type { ChecklistItem } from './types'

// ─────────────────────────────────────────────────────────────
// DRY VAN CHECKLIST (the original default trailer checklist)
// ─────────────────────────────────────────────────────────────

export const DRY_VAN_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Trailer Exterior
  { id: 'ext-doors',    category: 'Trailer Exterior', label: 'Rear Doors & Seals',                mandatory: true },
  { id: 'ext-roof',     category: 'Trailer Exterior', label: 'Roof & Sides (No Damage)',           mandatory: true },
  { id: 'ext-frame',    category: 'Trailer Exterior', label: 'Frame & Undercarriage',              mandatory: true },
  { id: 'ext-floor',    category: 'Trailer Exterior', label: 'Floor Condition (No Soft Spots)',    mandatory: true },
  { id: 'ext-landing',  category: 'Trailer Exterior', label: 'Landing Gear (Retracted & Secure)',  mandatory: true },
  { id: 'ext-plate',    category: 'Trailer Exterior', label: 'License Plate (Visible & Secure)',   mandatory: true },
  { id: 'ext-mudflaps', category: 'Trailer Exterior', label: 'Mud Flaps (Installed & Intact)',     mandatory: true },

  // Lights & Reflectors
  { id: 'lt-tail',       category: 'Lights & Reflectors', label: 'Tail Lights',                  mandatory: true },
  { id: 'lt-brake',      category: 'Lights & Reflectors', label: 'Brake Lights',                 mandatory: true },
  { id: 'lt-turn',       category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)',  mandatory: true },
  { id: 'lt-clearance',  category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',    mandatory: true },
  { id: 'lt-reflectors', category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',        mandatory: true },
  { id: 'lt-abs',        category: 'Lights & Reflectors', label: 'ABS Light (Off When Running)',  mandatory: true },
]

// Backward-compat alias — DEFAULT_CHECKLIST is the same list as DRY_VAN_CHECKLIST.
export const DEFAULT_CHECKLIST = DRY_VAN_CHECKLIST

// ─────────────────────────────────────────────────────────────
// REEFER CHECKLIST — dry van base + refrigeration-specific items.
// A reefer's whole job depends on things a dry van doesn't have:
// the unit itself, an airtight box, and a working air path.
// ─────────────────────────────────────────────────────────────

export const REEFER_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Trailer Exterior
  { id: 'rf-doors',    category: 'Trailer Exterior', label: 'Rear Doors & Seals',               mandatory: true },
  { id: 'rf-frame',    category: 'Trailer Exterior', label: 'Frame & Undercarriage',             mandatory: true },
  { id: 'rf-floor',    category: 'Trailer Exterior', label: 'Floor Condition (No Soft Spots)',   mandatory: true },
  { id: 'rf-landing',  category: 'Trailer Exterior', label: 'Landing Gear (Retracted & Secure)', mandatory: true },
  { id: 'rf-plate',    category: 'Trailer Exterior', label: 'License Plate (Visible & Secure)',  mandatory: true },
  { id: 'rf-mudflaps', category: 'Trailer Exterior', label: 'Mud Flaps (Installed & Intact)',    mandatory: true },

  // Refrigeration Unit
  { id: 'rf-fuel',     category: 'Refrigeration Unit', label: 'Reefer Unit Fuel Level',              mandatory: true },
  { id: 'rf-settemp',  category: 'Refrigeration Unit', label: 'Set Temperature Correct for Load',    mandatory: true },
  { id: 'rf-hours',    category: 'Refrigeration Unit', label: 'Unit Operating Hours / Runtime',       mandatory: true },
  { id: 'rf-startup',  category: 'Refrigeration Unit', label: 'Unit Starts & Runs Without Fault Code', mandatory: true },
  { id: 'rf-defrost',  category: 'Refrigeration Unit', label: 'Defrost Cycle Functioning',            mandatory: false },

  // Insulation & Air Path — a puncture or blocked airflow ruins the load
  { id: 'rf-walls',    category: 'Insulation & Air Path', label: 'Insulation / Walls — No Punctures',   mandatory: true },
  { id: 'rf-airchute', category: 'Insulation & Air Path', label: 'Air Chute / Air Delivery Intact',      mandatory: true },
  { id: 'rf-bulkhead', category: 'Insulation & Air Path', label: 'Return Air Bulkhead in Place',         mandatory: true },
  { id: 'rf-doorseal', category: 'Insulation & Air Path', label: 'Door Seals Airtight (No Gaps)',        mandatory: true },

  // Lights & Reflectors
  { id: 'rf-taillt',    category: 'Lights & Reflectors', label: 'Tail Lights',                 mandatory: true },
  { id: 'rf-brakelt',   category: 'Lights & Reflectors', label: 'Brake Lights',                mandatory: true },
  { id: 'rf-turnlt',    category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)', mandatory: true },
  { id: 'rf-clearlt',   category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',   mandatory: true },
  { id: 'rf-reflect',   category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',      mandatory: true },
]

// ─────────────────────────────────────────────────────────────
// FLATBED CHECKLIST — no walls, roof, or doors. The checklist is
// entirely about securement: deck, tie-downs, tarps, chains, straps.
// ─────────────────────────────────────────────────────────────

export const FLATBED_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Deck & Structure
  { id: 'fb-deck',      category: 'Deck & Structure', label: 'Deck Condition (No Cracks / Splinters)', mandatory: true },
  { id: 'fb-headboard', category: 'Deck & Structure', label: 'Headboard — No Damage, Secure',           mandatory: true },
  { id: 'fb-frame',     category: 'Deck & Structure', label: 'Frame & Undercarriage',                   mandatory: true },
  { id: 'fb-landing',   category: 'Deck & Structure', label: 'Landing Gear (Retracted & Secure)',       mandatory: true },
  { id: 'fb-plate',     category: 'Deck & Structure', label: 'License Plate (Visible & Secure)',        mandatory: true },
  { id: 'fb-mudflaps',  category: 'Deck & Structure', label: 'Mud Flaps (Installed & Intact)',          mandatory: true },

  // Securement Equipment
  { id: 'fb-stakepkt',  category: 'Securement Equipment', label: 'Stake Pockets Functional',        mandatory: true },
  { id: 'fb-tierail',   category: 'Securement Equipment', label: 'Tie-Down Rail / D-Rings Secure',  mandatory: true },
  { id: 'fb-tarps',     category: 'Securement Equipment', label: 'Tarps Present & Good Condition',  mandatory: false },
  { id: 'fb-chains',    category: 'Securement Equipment', label: 'Chains — Counted & Inspected',    mandatory: true },
  { id: 'fb-binders',   category: 'Securement Equipment', label: 'Load Binders Functional',         mandatory: true },
  { id: 'fb-straps',    category: 'Securement Equipment', label: 'Straps — Counted & Good Condition', mandatory: true },
  { id: 'fb-edgeprot',  category: 'Securement Equipment', label: 'Edge Protectors Available',       mandatory: false },

  // Lights & Reflectors
  { id: 'fb-taillt',   category: 'Lights & Reflectors', label: 'Tail Lights',                 mandatory: true },
  { id: 'fb-brakelt',  category: 'Lights & Reflectors', label: 'Brake Lights',                mandatory: true },
  { id: 'fb-turnlt',   category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)', mandatory: true },
  { id: 'fb-clearlt',  category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',   mandatory: true },
  { id: 'fb-reflect',  category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',      mandatory: true },
]

// ─────────────────────────────────────────────────────────────
// STEPDECK CHECKLIST — flatbed items plus the deck-step transition.
// ─────────────────────────────────────────────────────────────

export const STEPDECK_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  ...FLATBED_CHECKLIST,
  { id: 'sd-ramp',      category: 'Deck & Structure', label: 'Upper/Lower Deck Transition Ramp',  mandatory: true },
  { id: 'sd-clearance', category: 'Deck & Structure', label: 'Lower Deck Ground Clearance',       mandatory: true },
  { id: 'sd-beaver',    category: 'Securement Equipment', label: 'Beavertail Ramps (If Equipped)', mandatory: false },
]

// ─────────────────────────────────────────────────────────────
// TRUCK INSPECTION CHECKLIST (Full)
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

  // In-Cab Devices
  { id: 'cab-extng',     category: 'In-Cab Devices', label: 'Fire Extinguisher',      mandatory: true },
  { id: 'cab-triangles', category: 'In-Cab Devices', label: '3 Emergency Triangles',  mandatory: true },

  // Documents (In-Cab Folder)
  { id: 'doc2-company',   category: 'Documents (Cab Folder)', label: 'Company Information',                    mandatory: true },
  { id: 'doc2-regcard',   category: 'Documents (Cab Folder)', label: 'Registration (Cab Card)',                mandatory: true },
  { id: 'doc2-mc',        category: 'Documents (Cab Folder)', label: 'MC Certificate (Motor Carrier)',         mandatory: true },
  { id: 'doc2-ifta',      category: 'Documents (Cab Folder)', label: 'IFTA (Intl. Fuel Tax Agreement)',        mandatory: true },
  { id: 'doc2-insurance', category: 'Documents (Cab Folder)', label: 'Certificate of Insurance',               mandatory: true },
  { id: 'doc2-annual',    category: 'Documents (Cab Folder)', label: 'Truck & Trailer Annual Inspection',      mandatory: true },
  { id: 'doc2-lease',     category: 'Documents (Cab Folder)', label: 'Lease Agreement (Lessor / Lessee)',      mandatory: false },
  { id: 'doc2-kyu',       category: 'Documents (Cab Folder)', label: 'KYU Permit (Kentucky)',                  mandatory: false },
  { id: 'doc2-nm',        category: 'Documents (Cab Folder)', label: 'NM Permit (New Mexico)',                 mandatory: false },
  { id: 'doc2-hut',       category: 'Documents (Cab Folder)', label: 'HUT Permit (New York State)',            mandatory: false },
  { id: 'doc2-oregon',    category: 'Documents (Cab Folder)', label: 'Oregon Permit',                          mandatory: false },
  { id: 'doc2-pa',        category: 'Documents (Cab Folder)', label: 'PA Insect Inspection Certificate',       mandatory: false },
  { id: 'doc2-gpsman',    category: 'Documents (Cab Folder)', label: 'GPS / ELD Tab Manual',                   mandatory: true },
  { id: 'doc2-safety',    category: 'Documents (Cab Folder)', label: 'Driver Safety Policy & Manual',          mandatory: true },
  { id: 'doc2-efschk',    category: 'Documents (Cab Folder)', label: 'EFS Checks',                             mandatory: false },
  { id: 'doc2-tripsheet', category: 'Documents (Cab Folder)', label: 'Trip Report Sheets',                     mandatory: false },
  { id: 'doc2-drugforms', category: 'Documents (Cab Folder)', label: 'Drug Test Forms (Custody & Control)',    mandatory: true },
  { id: 'doc2-paperlog',  category: 'Documents (Cab Folder)', label: 'Paper Log Book (ELD Malfunction)',       mandatory: true },
  { id: 'doc2-efscard',   category: 'Documents (Cab Folder)', label: 'EFS Fuel Card',                          mandatory: false },
  { id: 'doc2-tafscard',  category: 'Documents (Cab Folder)', label: 'TAFS Fuel Card',                         mandatory: false },

  // Externally Displayed Signs & Decals — deliberately no hard-coded
  // USDOT/MC/KYU numbers here: those vary by which of Zone LLC, Xtrack
  // LLC, or AFG Transportco a given truck belongs to, and this list is
  // shared across all three. A driver checks that THEIR company's numbers
  // are correctly displayed, not a specific number baked into the app.
  { id: 'dec-carrier',  category: 'Signs & Decals', label: 'Carrier Sign (Company Name + USDOT / MC Numbers)', mandatory: true },
  { id: 'dec-unitnum',  category: 'Signs & Decals', label: 'Unit Number on Both Sides',                        mandatory: true },
  { id: 'dec-ifta',     category: 'Signs & Decals', label: 'IFTA Decals on Both Sides',                        mandatory: true },
  { id: 'dec-hut',      category: 'Signs & Decals', label: 'HUT Sticker (New York) Displayed on Front',        mandatory: false },
  { id: 'dec-gpstab',   category: 'Signs & Decals', label: 'GPS Tab Sticker',                                  mandatory: true },
  { id: 'dec-plate',    category: 'Signs & Decals', label: 'License Plate',                                    mandatory: true },

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

// ─────────────────────────────────────────────────────────────
// DAILY PTI CHECKLIST (truck) — everyday, safety-critical only.
// ─────────────────────────────────────────────────────────────

export const TRUCK_DAILY_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  { id: 'd-headlights', category: 'Lights',  label: 'Headlights (High & Low Beam)', mandatory: true },
  { id: 'd-brakelts',   category: 'Lights',  label: 'Brake Lights',                 mandatory: true },
  { id: 'd-turnsig',    category: 'Lights',  label: 'Turn Signals (Left & Right)',  mandatory: true },
  { id: 'd-marker',     category: 'Lights',  label: 'Marker & Clearance Lights',    mandatory: true },

  { id: 'd-steertire',  category: 'Tires & Wheels', label: 'Steer Tires (Tread & Pressure)',   mandatory: true },
  { id: 'd-drivetire',  category: 'Tires & Wheels', label: 'Drive Tires (Tread & Pressure)',   mandatory: true },
  { id: 'd-lugnuts',    category: 'Tires & Wheels', label: 'Lug Nuts Tight / No Rust Streaks', mandatory: true },

  { id: 'd-oilleak',    category: 'Leaks', label: 'No Oil Leaks',     mandatory: true },
  { id: 'd-coolleak',   category: 'Leaks', label: 'No Coolant Leaks', mandatory: true },
  { id: 'd-fuelleak',   category: 'Leaks', label: 'No Fuel Leaks',    mandatory: true },
  { id: 'd-airleak',    category: 'Leaks', label: 'No Air Leaks',     mandatory: true },

  { id: 'd-airpress',   category: 'Brakes & Air', label: 'Air Pressure Builds Normally', mandatory: true },
  { id: 'd-brakes',     category: 'Brakes & Air', label: 'Brakes Working',               mandatory: true },
  { id: 'd-airlines',   category: 'Brakes & Air', label: 'Air Lines Secure (No Chafing)', mandatory: true },

  { id: 'd-extng',      category: 'Safety Equipment', label: 'Fire Extinguisher (Charged & Secure)', mandatory: true },
  { id: 'd-triangles',  category: 'Safety Equipment', label: 'Emergency Triangles',                  mandatory: true },

  { id: 'd-wipers',     category: 'Cab', label: 'Wipers & Washer Fluid',    mandatory: true },
  { id: 'd-horn',       category: 'Cab', label: 'Horn',                    mandatory: true },
  { id: 'd-mirrors',    category: 'Cab', label: 'Mirrors Clean & Adjusted', mandatory: true },
  { id: 'd-dashwarn',   category: 'Cab', label: 'No Dash Warning Lights',  mandatory: true },
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

// ─────────────────────────────────────────────────────────────
// Composite-type resolution
// InspectionType is a single string like 'TRAILER_PICKUP_REEFER' or
// 'TRUCK_DROPOFF_DAILY'. These helpers parse it rather than needing
// four separate fields threaded through every consuming page.
// ─────────────────────────────────────────────────────────────

export function buildChecklist(type?: string): ChecklistItem[] {
  let source: Omit<ChecklistItem, 'status' | 'notes'>[]

  if (!type) {
    source = DRY_VAN_CHECKLIST
  } else if (type.startsWith('TRUCK')) {
    source = type.endsWith('DAILY') ? TRUCK_DAILY_CHECKLIST : TRUCK_CHECKLIST
  } else if (type.includes('REEFER')) {
    source = REEFER_CHECKLIST
  } else if (type.includes('FLATBED')) {
    source = FLATBED_CHECKLIST
  } else if (type.includes('STEPDECK')) {
    source = STEPDECK_CHECKLIST
  } else {
    source = DRY_VAN_CHECKLIST // DRY_VAN and any unrecognized trailer type
  }

  return source.map((item) => ({
    ...item,
    status: 'PENDING' as const,
    notes: '',
  }))
}

export function getTirePositions(type?: string): string[] {
  return type?.startsWith('TRUCK') ? TRUCK_TIRE_POSITIONS : TIRE_POSITIONS
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
