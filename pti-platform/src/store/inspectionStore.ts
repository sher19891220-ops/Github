import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  InspectionType, Driver, Vehicle, GPSCoordinates,
  CapturedPhoto, ChecklistItem, DamageMarker, AngleKey
} from '@/lib/types'
import { buildChecklist } from '@/lib/checklist'
import { generateId, generateSessionToken } from '@/lib/utils'

interface InspectionState {
  sessionToken: string | null
  inspectionType: InspectionType | null
  inspectionId: string | null
  driver: Driver | null
  vehicle: Vehicle | null
  odometer: number
  fuelLevel: number
  gps: GPSCoordinates | null
  photos: CapturedPhoto[]
  currentAngle: AngleKey | null
  checklist: ChecklistItem[]
  damageMarkers: DamageMarker[]
  signatureDataUrl: string | null

  initSession: (type: InspectionType, driver: Driver, vehicle: Vehicle) => void
  setOdometer: (v: number) => void
  setFuelLevel: (v: number) => void
  setGPS: (gps: GPSCoordinates) => void
  addPhoto: (photo: CapturedPhoto) => void
  removePhoto: (angleKey: AngleKey) => void
  setCurrentAngle: (angle: AngleKey | null) => void
  updateChecklistItem: (id: string, status: ChecklistItem['status'], notes?: string) => void
  addDamageMarker: (marker: Omit<DamageMarker, 'id'>) => void
  removeDamageMarker: (id: string) => void
  setSignature: (dataUrl: string) => void
  reset: () => void
}

const defaultState = {
  sessionToken: null,
  inspectionType: null,
  inspectionId: null,
  driver: null,
  vehicle: null,
  odometer: 0,
  fuelLevel: 0.5,
  gps: null,
  photos: [] as CapturedPhoto[],
  currentAngle: null as AngleKey | null,
  checklist: [] as ChecklistItem[],
  damageMarkers: [] as DamageMarker[],
  signatureDataUrl: null,
}

export const useInspectionStore = create<InspectionState>()(
  persist(
    (set) => ({
      ...defaultState,

      initSession: (type, driver, vehicle) =>
        set({
          sessionToken: generateSessionToken(),
          inspectionId: generateId(),
          inspectionType: type,
          driver,
          vehicle,
          checklist: buildChecklist(),
          photos: [],
          damageMarkers: [],
          signatureDataUrl: null,
          odometer: 0,
          fuelLevel: 0.5,
          gps: null,
        }),

      setOdometer: (v) => set({ odometer: v }),
      setFuelLevel: (v) => set({ fuelLevel: v }),
      setGPS: (gps) => set({ gps }),

      addPhoto: (photo) =>
        set((s) => ({
          photos: [...s.photos.filter((p) => p.angle !== photo.angle), photo],
        })),

      removePhoto: (angleKey) =>
        set((s) => ({ photos: s.photos.filter((p) => p.angle !== angleKey) })),

      setCurrentAngle: (angle) => set({ currentAngle: angle }),

      updateChecklistItem: (id, status, notes) =>
        set((s) => ({
          checklist: s.checklist.map((item) =>
            item.id === id ? { ...item, status, notes: notes ?? item.notes } : item
          ),
        })),

      addDamageMarker: (marker) =>
        set((s) => ({
          damageMarkers: [...s.damageMarkers, { ...marker, id: generateId() }],
        })),

      removeDamageMarker: (id) =>
        set((s) => ({ damageMarkers: s.damageMarkers.filter((m) => m.id !== id) })),

      setSignature: (dataUrl) => set({ signatureDataUrl: dataUrl }),

      reset: () => set(defaultState),
    }),
    { name: 'pti-inspection-session' }
  )
)
