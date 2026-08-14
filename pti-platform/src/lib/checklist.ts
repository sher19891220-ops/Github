import type { ChecklistItem } from './types'

export const DEFAULT_CHECKLIST: Omit<ChecklistItem, 'status' | 'notes'>[] = [
  // Engine Compartment
  { id: 'eng-oil', category: 'Engine Compartment', label: 'Engine Oil Level', mandatory: true },
  { id: 'eng-coolant', category: 'Engine Compartment', label: 'Coolant Level', mandatory: true },
  { id: 'eng-belts', category: 'Engine Compartment', label: 'Drive Belts & Hoses', mandatory: true },
  { id: 'eng-battery', category: 'Engine Compartment', label: 'Battery Condition', mandatory: true },
  { id: 'eng-leaks', category: 'Engine Compartment', label: 'No Fluid Leaks', mandatory: true },

  // Cab / Interior
  { id: 'cab-horn', category: 'Cab / Interior', label: 'Horn Operation', mandatory: true },
  { id: 'cab-wipers', category: 'Cab / Interior', label: 'Windshield Wipers', mandatory: true },
  { id: 'cab-mirrors', category: 'Cab / Interior', label: 'Mirrors Adjusted & Clean', mandatory: true },
  { id: 'cab-seatbelt', category: 'Cab / Interior', label: 'Seatbelt Functional', mandatory: true },
  { id: 'cab-dash', category: 'Cab / Interior', label: 'No Warning Lights on Dash', mandatory: true },
  { id: 'cab-fire-ext', category: 'Cab / Interior', label: 'Fire Extinguisher Present', mandatory: true },
  { id: 'cab-first-aid', category: 'Cab / Interior', label: 'First Aid Kit Present', mandatory: false },
  { id: 'cab-triangles', category: 'Cab / Interior', label: 'Emergency Triangles / Flares', mandatory: true },

  // Lights & Signals
  { id: 'lights-head', category: 'Lights & Signals', label: 'Headlights (High/Low)', mandatory: true },
  { id: 'lights-tail', category: 'Lights & Signals', label: 'Tail Lights', mandatory: true },
  { id: 'lights-brake', category: 'Lights & Signals', label: 'Brake Lights', mandatory: true },
  { id: 'lights-turn', category: 'Lights & Signals', label: 'Turn Signals (All 4)', mandatory: true },
  { id: 'lights-hazard', category: 'Lights & Signals', label: 'Hazard Lights', mandatory: true },
  { id: 'lights-clear', category: 'Lights & Signals', label: 'Clearance / Marker Lights', mandatory: true },
  { id: 'lights-reverse', category: 'Lights & Signals', label: 'Reverse Lights', mandatory: false },

  // Brakes
  { id: 'brake-service', category: 'Brakes', label: 'Service Brake Function', mandatory: true },
  { id: 'brake-parking', category: 'Brakes', label: 'Parking Brake Function', mandatory: true },
  { id: 'brake-air-psi', category: 'Brakes', label: 'Air Pressure (90–120 PSI)', mandatory: true },
  { id: 'brake-lines', category: 'Brakes', label: 'Air Lines / Hoses (No Leaks)', mandatory: true },

  // Tires & Wheels
  { id: 'tire-steer', category: 'Tires & Wheels', label: 'Steer Tires (Tread & Pressure)', mandatory: true },
  { id: 'tire-drives', category: 'Tires & Wheels', label: 'Drive Tires (Tread & Pressure)', mandatory: true },
  { id: 'tire-trailer', category: 'Tires & Wheels', label: 'Trailer Tires (Tread & Pressure)', mandatory: true },
  { id: 'wheel-lugs', category: 'Tires & Wheels', label: 'Wheel Lug Nuts Secure', mandatory: true },
  { id: 'wheel-rims', category: 'Tires & Wheels', label: 'Rim Condition (No Cracks)', mandatory: true },

  // Trailer
  { id: 'trailer-doors', category: 'Trailer', label: 'Trailer Doors & Seals', mandatory: true },
  { id: 'trailer-landing', category: 'Trailer', label: 'Landing Gear Secure', mandatory: true },
  { id: 'trailer-coupling', category: 'Trailer', label: 'Fifth Wheel / Coupling Secure', mandatory: true },
  { id: 'trailer-lights', category: 'Trailer', label: 'Trailer Light Plug Connected', mandatory: true },
  { id: 'trailer-brakes', category: 'Trailer', label: 'Trailer Brakes Connected', mandatory: true },
  { id: 'trailer-cargo', category: 'Trailer', label: 'Cargo Properly Secured', mandatory: false },
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
