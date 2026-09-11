import type { ChecklistItem } from './types'

// ─────────────────────────────────────────────────────────────
// DRY VAN CHECKLIST (the original default trailer checklist)
// ─────────────────────────────────────────────────────────────

export const DRY_VAN_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Trailer Exterior
  { id: 'ext-doors',    category: 'Trailer Exterior', label: 'Rear Doors & Seals',                mandatory: false },
  { id: 'ext-roof',     category: 'Trailer Exterior', label: 'Roof & Sides (No Damage)',           mandatory: false },
  { id: 'ext-frame',    category: 'Trailer Exterior', label: 'Frame & Undercarriage',              mandatory: false },
  { id: 'ext-floor',    category: 'Trailer Exterior', label: 'Floor Condition (No Soft Spots)',    mandatory: false },
  { id: 'ext-landing',  category: 'Trailer Exterior', label: 'Landing Gear (Retracted & Secure)',  mandatory: false },
  { id: 'ext-plate',    category: 'Trailer Exterior', label: 'License Plate (Visible & Secure)',   mandatory: false },
  { id: 'ext-mudflaps', category: 'Trailer Exterior', label: 'Mud Flaps (Installed & Intact)',     mandatory: false },

  // Lights & Reflectors
  { id: 'lt-tail',       category: 'Lights & Reflectors', label: 'Tail Lights',                  mandatory: false },
  { id: 'lt-brake',      category: 'Lights & Reflectors', label: 'Brake Lights',                 mandatory: false },
  { id: 'lt-turn',       category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)',  mandatory: false },
  { id: 'lt-clearance',  category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',    mandatory: false },
  { id: 'lt-reflectors', category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',        mandatory: false },
  { id: 'lt-abs',        category: 'Lights & Reflectors', label: 'ABS Light (Off When Running)',  mandatory: false },
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
  { id: 'rf-doors',    category: 'Trailer Exterior', label: 'Rear Doors & Seals',               mandatory: false },
  { id: 'rf-frame',    category: 'Trailer Exterior', label: 'Frame & Undercarriage',             mandatory: false },
  { id: 'rf-floor',    category: 'Trailer Exterior', label: 'Floor Condition (No Soft Spots)',   mandatory: false },
  { id: 'rf-landing',  category: 'Trailer Exterior', label: 'Landing Gear (Retracted & Secure)', mandatory: false },
  { id: 'rf-plate',    category: 'Trailer Exterior', label: 'License Plate (Visible & Secure)',  mandatory: false },
  { id: 'rf-mudflaps', category: 'Trailer Exterior', label: 'Mud Flaps (Installed & Intact)',    mandatory: false },

  // Refrigeration Unit
  { id: 'rf-fuel',     category: 'Refrigeration Unit', label: 'Reefer Unit Fuel Level',              mandatory: false },
  { id: 'rf-settemp',  category: 'Refrigeration Unit', label: 'Set Temperature Correct for Load',    mandatory: false },
  { id: 'rf-hours',    category: 'Refrigeration Unit', label: 'Unit Operating Hours / Runtime',       mandatory: false },
  { id: 'rf-startup',  category: 'Refrigeration Unit', label: 'Unit Starts & Runs Without Fault Code', mandatory: false },
  { id: 'rf-defrost',  category: 'Refrigeration Unit', label: 'Defrost Cycle Functioning',            mandatory: false },

  // Insulation & Air Path — a puncture or blocked airflow ruins the load
  { id: 'rf-walls',    category: 'Insulation & Air Path', label: 'Insulation / Walls — No Punctures',   mandatory: false },
  { id: 'rf-airchute', category: 'Insulation & Air Path', label: 'Air Chute / Air Delivery Intact',      mandatory: false },
  { id: 'rf-bulkhead', category: 'Insulation & Air Path', label: 'Return Air Bulkhead in Place',         mandatory: false },
  { id: 'rf-doorseal', category: 'Insulation & Air Path', label: 'Door Seals Airtight (No Gaps)',        mandatory: false },

  // Lights & Reflectors
  { id: 'rf-taillt',    category: 'Lights & Reflectors', label: 'Tail Lights',                 mandatory: false },
  { id: 'rf-brakelt',   category: 'Lights & Reflectors', label: 'Brake Lights',                mandatory: false },
  { id: 'rf-turnlt',    category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)', mandatory: false },
  { id: 'rf-clearlt',   category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',   mandatory: false },
  { id: 'rf-reflect',   category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',      mandatory: false },
]

// ─────────────────────────────────────────────────────────────
// FLATBED CHECKLIST — no walls, roof, or doors. The checklist is
// entirely about securement: deck, tie-downs, tarps, chains, straps.
// ─────────────────────────────────────────────────────────────

export const FLATBED_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Deck & Structure
  { id: 'fb-deck',      category: 'Deck & Structure', label: 'Deck Condition (No Cracks / Splinters)', mandatory: false },
  { id: 'fb-headboard', category: 'Deck & Structure', label: 'Headboard — No Damage, Secure',           mandatory: false },
  { id: 'fb-frame',     category: 'Deck & Structure', label: 'Frame & Undercarriage',                   mandatory: false },
  { id: 'fb-landing',   category: 'Deck & Structure', label: 'Landing Gear (Retracted & Secure)',       mandatory: false },
  { id: 'fb-plate',     category: 'Deck & Structure', label: 'License Plate (Visible & Secure)',        mandatory: false },
  { id: 'fb-mudflaps',  category: 'Deck & Structure', label: 'Mud Flaps (Installed & Intact)',          mandatory: false },

  // Securement Equipment
  { id: 'fb-stakepkt',  category: 'Securement Equipment', label: 'Stake Pockets Functional',        mandatory: false },
  { id: 'fb-tierail',   category: 'Securement Equipment', label: 'Tie-Down Rail / D-Rings Secure',  mandatory: false },
  { id: 'fb-tarps',     category: 'Securement Equipment', label: 'Tarps Present & Good Condition',  mandatory: false },
  { id: 'fb-chains',    category: 'Securement Equipment', label: 'Chains — Counted & Inspected',    mandatory: false },
  { id: 'fb-binders',   category: 'Securement Equipment', label: 'Load Binders Functional',         mandatory: false },
  { id: 'fb-straps',    category: 'Securement Equipment', label: 'Straps — Counted & Good Condition', mandatory: false },
  { id: 'fb-edgeprot',  category: 'Securement Equipment', label: 'Edge Protectors Available',       mandatory: false },

  // Lights & Reflectors
  { id: 'fb-taillt',   category: 'Lights & Reflectors', label: 'Tail Lights',                 mandatory: false },
  { id: 'fb-brakelt',  category: 'Lights & Reflectors', label: 'Brake Lights',                mandatory: false },
  { id: 'fb-turnlt',   category: 'Lights & Reflectors', label: 'Turn Signals (Left & Right)', mandatory: false },
  { id: 'fb-clearlt',  category: 'Lights & Reflectors', label: 'Clearance / Marker Lights',   mandatory: false },
  { id: 'fb-reflect',  category: 'Lights & Reflectors', label: 'Reflectors (All Sides)',      mandatory: false },
]

// ─────────────────────────────────────────────────────────────
// STEPDECK CHECKLIST — flatbed items plus the deck-step transition.
// ─────────────────────────────────────────────────────────────

export const STEPDECK_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  ...FLATBED_CHECKLIST,
  { id: 'sd-ramp',      category: 'Deck & Structure', label: 'Upper/Lower Deck Transition Ramp',  mandatory: false },
  { id: 'sd-clearance', category: 'Deck & Structure', label: 'Lower Deck Ground Clearance',       mandatory: false },
  { id: 'sd-beaver',    category: 'Securement Equipment', label: 'Beavertail Ramps (If Equipped)', mandatory: false },
]

// ─────────────────────────────────────────────────────────────
// TRUCK INSPECTION CHECKLIST (Full)
// ─────────────────────────────────────────────────────────────

export const TRUCK_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Truck Stickers & Papers
  { id: 'doc-nyhut',      category: 'Stickers & Papers', label: 'NY HUT Sticker',     mandatory: false },
  { id: 'doc-ifta',       category: 'Stickers & Papers', label: 'IFTA Sticker',       mandatory: false },
  { id: 'doc-dot',        category: 'Stickers & Papers', label: 'DOT',                mandatory: false },
  { id: 'doc-reg',        category: 'Stickers & Papers', label: 'Registration',       mandatory: false },
  { id: 'doc-folder',     category: 'Stickers & Papers', label: 'Truck Folder',       mandatory: false },
  { id: 'doc-plate',      category: 'Stickers & Papers', label: 'Plate Number',       mandatory: false },
  { id: 'doc-eld',        category: 'Stickers & Papers', label: 'ELD Stickers',       mandatory: false },
  { id: 'doc-inspection', category: 'Stickers & Papers', label: 'Truck Inspection',   mandatory: false },

  // Interior
  { id: 'int-clean',    category: 'Interior', label: 'Cleanliness',           mandatory: false },
  { id: 'int-dash',     category: 'Interior', label: 'Dashboard',             mandatory: false },
  { id: 'int-lights',   category: 'Interior', label: 'Interior Lights',       mandatory: false },
  { id: 'int-latches',  category: 'Interior', label: 'Cabin Latches',         mandatory: false },
  { id: 'int-camera',   category: 'Interior', label: 'Camera System',         mandatory: false },
  { id: 'int-eld',      category: 'Interior', label: 'ELD System',            mandatory: false },
  { id: 'int-tablet',   category: 'Interior', label: 'Tablet Present',        mandatory: false },
  { id: 'int-gps',      category: 'Interior', label: 'GPS',                   mandatory: false },
  { id: 'int-fuelcard', category: 'Interior', label: 'Fuel Card',             mandatory: false },
  { id: 'int-mattress', category: 'Interior', label: 'Mattress',              mandatory: false },
  { id: 'int-inverter', category: 'Interior', label: 'Power Inverter',        mandatory: false },
  { id: 'int-fridge',   category: 'Interior', label: 'Fridge',                mandatory: false },
  { id: 'int-micro',    category: 'Interior', label: 'Microwave',             mandatory: false },
  { id: 'int-apu',      category: 'Interior', label: 'APU',                   mandatory: false },
  { id: 'int-heater',   category: 'Interior', label: 'Heater',                mandatory: false },
  { id: 'int-wipers',   category: 'Interior', label: 'Wipers',                mandatory: false },
  { id: 'int-wshield',  category: 'Interior', label: 'Windshield',            mandatory: false },
  { id: 'int-horns',    category: 'Interior', label: 'Horns',                 mandatory: false },
  { id: 'int-mirrorsw', category: 'Interior', label: 'Mirror Control Switch', mandatory: false },
  { id: 'int-extng',    category: 'Interior', label: 'Fire Extinguisher',     mandatory: false },
  { id: 'int-triangles',category: 'Interior', label: 'Emergency Triangles',   mandatory: false },
  { id: 'int-speedlim', category: 'Interior', label: 'Speed Limiter',         mandatory: false },

  // In-Cab Devices
  { id: 'cab-extng',     category: 'In-Cab Devices', label: 'Fire Extinguisher',      mandatory: false },
  { id: 'cab-triangles', category: 'In-Cab Devices', label: '3 Emergency Triangles',  mandatory: false },

  // Documents (In-Cab Folder)
  { id: 'doc2-company',   category: 'Documents (Cab Folder)', label: 'Company Information',                    mandatory: false },
  { id: 'doc2-regcard',   category: 'Documents (Cab Folder)', label: 'Registration (Cab Card)',                mandatory: false },
  { id: 'doc2-mc',        category: 'Documents (Cab Folder)', label: 'MC Certificate (Motor Carrier)',         mandatory: false },
  { id: 'doc2-ifta',      category: 'Documents (Cab Folder)', label: 'IFTA (Intl. Fuel Tax Agreement)',        mandatory: false },
  { id: 'doc2-insurance', category: 'Documents (Cab Folder)', label: 'Certificate of Insurance',               mandatory: false },
  { id: 'doc2-annual',    category: 'Documents (Cab Folder)', label: 'Truck & Trailer Annual Inspection',      mandatory: false },
  { id: 'doc2-lease',     category: 'Documents (Cab Folder)', label: 'Lease Agreement (Lessor / Lessee)',      mandatory: false },
  { id: 'doc2-kyu',       category: 'Documents (Cab Folder)', label: 'KYU Permit (Kentucky)',                  mandatory: false },
  { id: 'doc2-nm',        category: 'Documents (Cab Folder)', label: 'NM Permit (New Mexico)',                 mandatory: false },
  { id: 'doc2-hut',       category: 'Documents (Cab Folder)', label: 'HUT Permit (New York State)',            mandatory: false },
  { id: 'doc2-oregon',    category: 'Documents (Cab Folder)', label: 'Oregon Permit',                          mandatory: false },
  { id: 'doc2-pa',        category: 'Documents (Cab Folder)', label: 'PA Insect Inspection Certificate',       mandatory: false },
  { id: 'doc2-gpsman',    category: 'Documents (Cab Folder)', label: 'GPS / ELD Tab Manual',                   mandatory: false },
  { id: 'doc2-safety',    category: 'Documents (Cab Folder)', label: 'Driver Safety Policy & Manual',          mandatory: false },
  { id: 'doc2-efschk',    category: 'Documents (Cab Folder)', label: 'EFS Checks',                             mandatory: false },
  { id: 'doc2-tripsheet', category: 'Documents (Cab Folder)', label: 'Trip Report Sheets',                     mandatory: false },
  { id: 'doc2-drugforms', category: 'Documents (Cab Folder)', label: 'Drug Test Forms (Custody & Control)',    mandatory: false },
  { id: 'doc2-paperlog',  category: 'Documents (Cab Folder)', label: 'Paper Log Book (ELD Malfunction)',       mandatory: false },
  { id: 'doc2-efscard',   category: 'Documents (Cab Folder)', label: 'EFS Fuel Card',                          mandatory: false },
  { id: 'doc2-tafscard',  category: 'Documents (Cab Folder)', label: 'TAFS Fuel Card',                         mandatory: false },

  // Externally Displayed Signs & Decals — deliberately no hard-coded
  // USDOT/MC/KYU numbers here: those vary by which of Zone LLC, Xtrack
  // LLC, or AFG Transportco a given truck belongs to, and this list is
  // shared across all three. A driver checks that THEIR company's numbers
  // are correctly displayed, not a specific number baked into the app.
  { id: 'dec-carrier',  category: 'Signs & Decals', label: 'Carrier Sign (Company Name + USDOT / MC Numbers)', mandatory: false },
  { id: 'dec-unitnum',  category: 'Signs & Decals', label: 'Unit Number on Both Sides',                        mandatory: false },
  { id: 'dec-ifta',     category: 'Signs & Decals', label: 'IFTA Decals on Both Sides',                        mandatory: false },
  { id: 'dec-hut',      category: 'Signs & Decals', label: 'HUT Sticker (New York) Displayed on Front',        mandatory: false },
  { id: 'dec-gpstab',   category: 'Signs & Decals', label: 'GPS Tab Sticker',                                  mandatory: false },
  { id: 'dec-plate',    category: 'Signs & Decals', label: 'License Plate',                                    mandatory: false },

  // Exterior
  { id: 'tex-clean',     category: 'Exterior', label: 'Cleanliness',                   mandatory: false },
  { id: 'tex-airleaks',  category: 'Exterior', label: 'No Air Leaks',                  mandatory: false },
  { id: 'tex-plate',     category: 'Exterior', label: 'Plate Number Intact & Visible', mandatory: false },
  { id: 'tex-lights',    category: 'Exterior', label: 'Lights',                        mandatory: false },
  { id: 'tex-hood',      category: 'Exterior', label: 'Hood Operates',                 mandatory: false },
  { id: 'tex-fluids',    category: 'Exterior', label: 'Fluids',                        mandatory: false },
  { id: 'tex-noleaks',   category: 'Exterior', label: 'No Leaks',                      mandatory: false },
  { id: 'tex-engine',    category: 'Exterior', label: 'Engine Compartment',            mandatory: false },
  { id: 'tex-susp',      category: 'Exterior', label: 'Suspension Components',         mandatory: false },
  { id: 'tex-steertire', category: 'Exterior', label: 'Steer Tires',                   mandatory: false },
  { id: 'tex-drivetire', category: 'Exterior', label: 'Drive Tires',                   mandatory: false },
  { id: 'tex-brakes',    category: 'Exterior', label: 'Brakes Checked',                mandatory: false },
  { id: 'tex-airhoses',  category: 'Exterior', label: 'Three-in-One Air Hoses Secure', mandatory: false },
  { id: 'tex-loose',     category: 'Exterior', label: 'No Loose Hanging Parts',        mandatory: false },
  { id: 'tex-mudflap',   category: 'Exterior', label: 'Mudflap Secure',                mandatory: false },
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
  { id: 'd-headlights', category: 'Lights',  label: 'Headlights (High & Low Beam)', mandatory: false },
  { id: 'd-brakelts',   category: 'Lights',  label: 'Brake Lights',                 mandatory: false },
  { id: 'd-turnsig',    category: 'Lights',  label: 'Turn Signals (Left & Right)',  mandatory: false },
  { id: 'd-marker',     category: 'Lights',  label: 'Marker & Clearance Lights',    mandatory: false },

  { id: 'd-steertire',  category: 'Tires & Wheels', label: 'Steer Tires (Tread & Pressure)',   mandatory: false },
  { id: 'd-drivetire',  category: 'Tires & Wheels', label: 'Drive Tires (Tread & Pressure)',   mandatory: false },
  { id: 'd-lugnuts',    category: 'Tires & Wheels', label: 'Lug Nuts Tight / No Rust Streaks', mandatory: false },

  { id: 'd-oilleak',    category: 'Leaks', label: 'No Oil Leaks',     mandatory: false },
  { id: 'd-coolleak',   category: 'Leaks', label: 'No Coolant Leaks', mandatory: false },
  { id: 'd-fuelleak',   category: 'Leaks', label: 'No Fuel Leaks',    mandatory: false },
  { id: 'd-airleak',    category: 'Leaks', label: 'No Air Leaks',     mandatory: false },

  { id: 'd-airpress',   category: 'Brakes & Air', label: 'Air Pressure Builds Normally', mandatory: false },
  { id: 'd-brakes',     category: 'Brakes & Air', label: 'Brakes Working',               mandatory: false },
  { id: 'd-airlines',   category: 'Brakes & Air', label: 'Air Lines Secure (No Chafing)', mandatory: false },

  { id: 'd-extng',      category: 'Safety Equipment', label: 'Fire Extinguisher (Charged & Secure)', mandatory: false },
  { id: 'd-triangles',  category: 'Safety Equipment', label: 'Emergency Triangles',                  mandatory: false },

  { id: 'd-wipers',     category: 'Cab', label: 'Wipers & Washer Fluid',    mandatory: false },
  { id: 'd-horn',       category: 'Cab', label: 'Horn',                    mandatory: false },
  { id: 'd-mirrors',    category: 'Cab', label: 'Mirrors Clean & Adjusted', mandatory: false },
  { id: 'd-dashwarn',   category: 'Cab', label: 'No Dash Warning Lights',  mandatory: false },
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
