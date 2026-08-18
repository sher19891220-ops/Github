import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  InspectionType, Driver, Vehicle, GPSCoordinates,
  CapturedPhoto, ChecklistItem, DamageMarker, AngleKey, TireInspection, TireCondition
} from '@/lib/types'
import { buildChecklist, TIRE_POSITIONS } from '@/lib/checklist'
import { generateId, generateSessionToken } from '@/lib/utils'

function buildTires(): TireInspection[] {
  return TIRE_POSITIONS.map((position) => ({ position, condition: null, psi: '' }))
}

interface InspectionState {
  sessionToken: string | null
  inspectionType: InspectionType | null
  inspectionId: string | null
  driver: Driver | null
  vehicle: Vehicle | null
  gps: GPSCoordinates | null
  photos: CapturedPhoto[]
  currentAngle: AngleKey | null
  checklist: ChecklistItem[]
  tireInspections: TireInspection[]
  damageMarkers: DamageMarker[]
  signatureDataUrl: string | null
  comments: string
  sourceChatId: number | null

  initSession: (type: InspectionType, driver: Driver, vehicle: Vehicle, sourceChatId?: number | null) => void
  setGPS: (gps: GPSCoordinates) => void
  addPhoto: (photo: CapturedPhoto) => void
  removePhoto: (angleKey: AngleKey) => void
  setCurrentAngle: (angle: AngleKey | null) => void
  updateChecklistItem: (id: string, status: ChecklistItem['status'], notes?: string) => void
  updateTireCondition: (position: string, condition: TireCondition) => void
  updateTirePsi: (position: string, psi: string) => void
  setComments: (v: string) => void
  setSignature: (dataUrl: string) => void
  reset: () => void
}

const defaultState = {
  sessionToken: null,
  inspectionType: null,
  inspectionId: null,
  driver: null,
  vehicle: null,
  gps: null,
  photos: [] as CapturedPhoto[],
  currentAngle: null as AngleKey | null,
  checklist: [] as ChecklistItem[],
  tireInspections: [] as TireInspection[],
  damageMarkers: [] as DamageMarker[],
  signatureDataUrl: null,
  comments: '',
  sourceChatId: null as number | null,
}

export const useInspectionStore = create<InspectionState>()(
  persist(
    (set) => ({
      ...defaultState,

      initSession: (type, driver, vehicle, sourceChatId = null) =>
        set({
          sessionToken: generateSessionToken(),
          inspectionId: generateId(),
          inspectionType: type,
          driver,
          vehicle,
          checklist: buildChecklist(),
          tireInspections: buildTires(),
          photos: [],
          damageMarkers: [],
          signatureDataUrl: null,
          gps: null,
          comments: '',
          sourceChatId,
        }),

      setGPS: (gps) => set({ gps }),

      addPhoto: (photo) =>
        set((s) => ({
          photos: photo.angle === 'extras'
            ? [...s.photos, photo]
            : [...s.photos.filter((p) => p.angle !== photo.angle), photo],
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

      updateTireCondition: (position, condition) =>
        set((s) => ({
          tireInspections: s.tireInspections.map((t) =>
            t.position === position ? { ...t, condition } : t
          ),
        })),

      updateTirePsi: (position, psi) =>
        set((s) => ({
          tireInspections: s.tireInspections.map((t) =>
            t.position === position ? { ...t, psi } : t
          ),
        })),

      setComments: (v) => set({ comments: v }),
      setSignature: (dataUrl) => set({ signatureDataUrl: dataUrl }),
      reset: () => set(defaultState),
    }),
    {
      name: 'pti-inspection-session',
      // photos and signatureDataUrl are large data URLs that blow past the 5 MB
      // localStorage limit — keep them in memory only for the current session.
      partialize: (state) => ({
        sessionToken: state.sessionToken,
        inspectionType: state.inspectionType,
        inspectionId: state.inspectionId,
        driver: state.driver,
        vehicle: state.vehicle,
        gps: state.gps,
        currentAngle: state.currentAngle,
        checklist: state.checklist,
        tireInspections: state.tireInspections,
        damageMarkers: state.damageMarkers,
        comments: state.comments,
        sourceChatId: state.sourceChatId,
      }),
    }
  )
)
