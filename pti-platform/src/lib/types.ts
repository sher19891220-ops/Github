export type InspectionType = 'PICKUP' | 'DROP_OFF'
export type InspectionStatus = 'PENDING' | 'IN_PROGRESS' | 'SUBMITTED' | 'REVIEWED'
export type ItemStatus = 'PASS' | 'FAIL' | 'NA' | 'PENDING'
export type TireCondition = 'GOOD' | 'FAIR' | 'NEEDS_ATTENTION'
export type Company = 'Zone LLC' | 'Xtrack LLC' | 'AFG Transportco'

export interface TireInspection {
  position: string
  condition: TireCondition | null
  psi: string
}

export interface Driver {
  id: string
  name: string
  licenseNumber: string
  company: Company
  phone?: string
  avatarInitials: string
}

export interface Vehicle {
  id: string
  unitNumber: string
  plateNumber: string
  make: string
  model: string
  year: number
  company: Company
  trailerNumber?: string
}

export interface GPSCoordinates {
  lat: number
  lng: number
  accuracy: number
  timestamp: string
  address?: string
}

export interface CapturedPhoto {
  id: string
  angle: AngleKey
  angleLabel: string
  dataUrl: string
  timestamp: string
  gps?: GPSCoordinates
  blurScore?: number
  passed: boolean
}

export type AngleKey =
  | 'front'
  | 'front-right'
  | 'right'
  | 'rear-right'
  | 'rear'
  | 'rear-left'
  | 'left'
  | 'front-left'
  | 'inside-roof'
  | 'floor'
  | 'inside-left-wall'
  | 'inside-right-wall'
  | 'damage'
  | 'tire-a1-lo'
  | 'tire-a1-li'
  | 'tire-a1-ri'
  | 'tire-a1-ro'
  | 'tire-a2-lo'
  | 'tire-a2-li'
  | 'tire-a2-ri'
  | 'tire-a2-ro'
  | 'extras'

export interface AngleConfig {
  key: AngleKey
  label: string
  instruction: string
  order: number
}

export interface ChecklistItem {
  id: string
  category: string
  label: string
  mandatory: boolean
  status: ItemStatus
  notes?: string
  photoRequired?: boolean
}

export interface DamageMarker {
  id: string
  x: number
  y: number
  view: 'top' | 'side'
  description: string
  severity: 'minor' | 'moderate' | 'severe'
}

export interface InspectionSession {
  id: string
  sessionToken: string
  type: InspectionType
  status: InspectionStatus
  driver: Driver
  vehicle: Vehicle
  odometer: number
  fuelLevel: number
  gps: GPSCoordinates | null
  photos: CapturedPhoto[]
  checklist: ChecklistItem[]
  damageMarkers: DamageMarker[]
  signatureDataUrl?: string
  submittedAt?: string
  createdAt: string
  updatedAt: string
  pdfUrl?: string
  telegramMessageId?: string
}

export interface InspectionSummary {
  id: string
  sessionToken: string
  type: InspectionType
  status: InspectionStatus
  driverName: string
  unitNumber: string
  company: Company
  submittedAt?: string
  createdAt: string
  failCount: number
  photoCount: number
  hasPdf: boolean
}

export interface AdminStats {
  totalInspectionsToday: number
  totalInspectionsWeek: number
  failRateToday: number
  activeDrivers: number
  pendingReview: number
  avgCompletionMinutes: number
}

export interface FleetVehicleStatus {
  vehicle: Vehicle
  lastInspection?: InspectionSummary
  currentDriver?: Driver
  gps?: GPSCoordinates
  status: 'ACTIVE' | 'IDLE' | 'MAINTENANCE' | 'UNKNOWN'
}
