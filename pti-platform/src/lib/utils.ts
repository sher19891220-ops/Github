import { clsx, type ClassValue } from 'clsx'
import type { InspectionType, ItemStatus } from './types'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function inspectionTypeLabel(type: InspectionType): string {
  return type === 'PICKUP' ? 'Pickup' : 'Drop-off'
}

export function inspectionTypeColor(type: InspectionType): string {
  return type === 'PICKUP' ? 'pickup' : 'dropoff'
}

export function statusLabel(status: ItemStatus): string {
  const map: Record<ItemStatus, string> = {
    PASS: 'Pass', FAIL: 'Fail', NA: 'N/A', PENDING: 'Pending',
  }
  return map[status]
}

export function fuelLevelLabel(level: number): string {
  if (level === 0) return 'Empty'
  if (level <= 0.25) return '1/4'
  if (level <= 0.5) return '1/2'
  if (level <= 0.75) return '3/4'
  return 'Full'
}

export function generateSessionToken(): string {
  return 'tkn-' + Math.random().toString(36).slice(2, 10)
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11)
}

export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
