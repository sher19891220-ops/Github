import type { Driver, Vehicle, InspectionSummary, FleetVehicleStatus, AdminStats, Company } from './types'

export const MOCK_DRIVERS: Driver[] = [
  { id: 'd1', name: 'Patrick Martinez', licenseNumber: 'TX-CDL-2847291', company: 'Zone LLC', phone: '+1-555-0101', avatarInitials: 'PM' },
  { id: 'd2', name: 'James Wilson', licenseNumber: 'TX-CDL-3940182', company: 'Zone LLC', phone: '+1-555-0102', avatarInitials: 'JW' },
  { id: 'd3', name: 'Maria Rodriguez', licenseNumber: 'TX-CDL-5821047', company: 'Xtrack LLC', phone: '+1-555-0103', avatarInitials: 'MR' },
  { id: 'd4', name: 'David Chen', licenseNumber: 'TX-CDL-7304951', company: 'AFG Transportco', phone: '+1-555-0104', avatarInitials: 'DC' },
  { id: 'd5', name: 'Sarah Johnson', licenseNumber: 'TX-CDL-9182736', company: 'Xtrack LLC', phone: '+1-555-0105', avatarInitials: 'SJ' },
]

export const MOCK_VEHICLES: Vehicle[] = [
  { id: 'v1', unitNumber: 'ZN-401', plateNumber: 'TX-84729', make: 'Kenworth', model: 'T680', year: 2022, company: 'Zone LLC', trailerNumber: 'TR-7741' },
  { id: 'v2', unitNumber: 'ZN-407', plateNumber: 'TX-84730', make: 'Peterbilt', model: '579', year: 2021, company: 'Zone LLC', trailerNumber: 'TR-8821' },
  { id: 'v3', unitNumber: 'XT-112', plateNumber: 'TX-91023', make: 'Freightliner', model: 'Cascadia', year: 2023, company: 'Xtrack LLC', trailerNumber: 'TR-4490' },
  { id: 'v4', unitNumber: 'XT-118', plateNumber: 'TX-91024', make: 'Volvo', model: 'VNL 860', year: 2022, company: 'Xtrack LLC' },
  { id: 'v5', unitNumber: 'AG-055', plateNumber: 'TX-77310', make: 'Kenworth', model: 'W990', year: 2023, company: 'AFG Transportco', trailerNumber: 'TR-2250' },
]

export const MOCK_INSPECTIONS: InspectionSummary[] = [
  {
    id: 'ins1', sessionToken: 'tkn-a1b2', type: 'PICKUP', status: 'SUBMITTED',
    driverName: 'Patrick Martinez', unitNumber: 'ZN-401', company: 'Zone LLC',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    submittedAt: new Date(Date.now() - 1.5 * 60 * 60 * 1000).toISOString(),
    failCount: 0, photoCount: 8, hasPdf: true,
  },
  {
    id: 'ins2', sessionToken: 'tkn-c3d4', type: 'DROP_OFF', status: 'SUBMITTED',
    driverName: 'James Wilson', unitNumber: 'ZN-407', company: 'Zone LLC',
    createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    submittedAt: new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString(),
    failCount: 1, photoCount: 8, hasPdf: true,
  },
  {
    id: 'ins3', sessionToken: 'tkn-e5f6', type: 'PICKUP', status: 'IN_PROGRESS',
    driverName: 'Maria Rodriguez', unitNumber: 'XT-112', company: 'Xtrack LLC',
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    failCount: 0, photoCount: 3, hasPdf: false,
  },
  {
    id: 'ins4', sessionToken: 'tkn-g7h8', type: 'DROP_OFF', status: 'REVIEWED',
    driverName: 'David Chen', unitNumber: 'AG-055', company: 'AFG Transportco',
    createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    submittedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    failCount: 2, photoCount: 8, hasPdf: true,
  },
  {
    id: 'ins5', sessionToken: 'tkn-i9j0', type: 'PICKUP', status: 'SUBMITTED',
    driverName: 'Sarah Johnson', unitNumber: 'XT-118', company: 'Xtrack LLC',
    createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    submittedAt: new Date(Date.now() - 5.5 * 60 * 60 * 1000).toISOString(),
    failCount: 0, photoCount: 8, hasPdf: true,
  },
]

export const MOCK_ADMIN_STATS: AdminStats = {
  totalInspectionsToday: 12,
  totalInspectionsWeek: 67,
  failRateToday: 8.3,
  activeDrivers: 5,
  pendingReview: 3,
  avgCompletionMinutes: 18,
}

export const MOCK_FLEET: FleetVehicleStatus[] = [
  {
    vehicle: MOCK_VEHICLES[0],
    lastInspection: MOCK_INSPECTIONS[0],
    currentDriver: MOCK_DRIVERS[0],
    gps: { lat: 29.7604, lng: -95.3698, accuracy: 5, timestamp: new Date().toISOString(), address: 'Houston, TX' },
    status: 'ACTIVE',
  },
  {
    vehicle: MOCK_VEHICLES[1],
    lastInspection: MOCK_INSPECTIONS[1],
    currentDriver: MOCK_DRIVERS[1],
    gps: { lat: 30.2672, lng: -97.7431, accuracy: 8, timestamp: new Date().toISOString(), address: 'Austin, TX' },
    status: 'ACTIVE',
  },
  {
    vehicle: MOCK_VEHICLES[2],
    lastInspection: MOCK_INSPECTIONS[2],
    currentDriver: MOCK_DRIVERS[2],
    gps: { lat: 32.7767, lng: -96.7970, accuracy: 12, timestamp: new Date().toISOString(), address: 'Dallas, TX' },
    status: 'ACTIVE',
  },
  {
    vehicle: MOCK_VEHICLES[3],
    status: 'IDLE',
    gps: { lat: 29.4241, lng: -98.4936, accuracy: 15, timestamp: new Date().toISOString(), address: 'San Antonio, TX' },
  },
  {
    vehicle: MOCK_VEHICLES[4],
    lastInspection: MOCK_INSPECTIONS[3],
    currentDriver: MOCK_DRIVERS[3],
    gps: { lat: 31.7619, lng: -106.4850, accuracy: 6, timestamp: new Date().toISOString(), address: 'El Paso, TX' },
    status: 'ACTIVE',
  },
]
