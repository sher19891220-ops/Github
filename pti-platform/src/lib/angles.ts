import type { AngleConfig, AngleKey } from './types'

export const INSPECTION_ANGLES: AngleConfig[] = [
  {
    key: 'front',
    label: 'Front',
    instruction: 'Stand directly in front of the vehicle. Capture full front bumper, lights, and grille.',
    order: 1,
  },
  {
    key: 'front-right',
    label: 'Front Right',
    instruction: 'Move to the front-right corner. Capture the cab corner, mirror, and right front tire.',
    order: 2,
  },
  {
    key: 'right',
    label: 'Right Side',
    instruction: 'Stand at the center of the right side. Capture the full length of the truck and trailer.',
    order: 3,
  },
  {
    key: 'rear-right',
    label: 'Rear Right',
    instruction: 'Move to the rear-right corner. Capture the rear axle, tires, and trailer corner.',
    order: 4,
  },
  {
    key: 'rear',
    label: 'Rear',
    instruction: 'Stand directly behind the vehicle. Capture full rear doors, lights, and ICC bar.',
    order: 5,
  },
  {
    key: 'rear-left',
    label: 'Rear Left',
    instruction: 'Move to the rear-left corner. Capture the rear axle, tires, and trailer corner.',
    order: 6,
  },
  {
    key: 'left',
    label: 'Left Side',
    instruction: 'Stand at the center of the left side. Capture the full length from front to rear.',
    order: 7,
  },
  {
    key: 'front-left',
    label: 'Front Left',
    instruction: 'Move to the front-left corner. Capture cab corner, driver door, and left front tire.',
    order: 8,
  },
]

export const ANGLE_POSITIONS: Record<AngleKey, { top: string; left: string; rotate: string }> = {
  front: { top: '8%', left: '50%', rotate: '0deg' },
  'front-right': { top: '20%', left: '80%', rotate: '45deg' },
  right: { top: '50%', left: '92%', rotate: '90deg' },
  'rear-right': { top: '80%', left: '80%', rotate: '135deg' },
  rear: { top: '92%', left: '50%', rotate: '180deg' },
  'rear-left': { top: '80%', left: '20%', rotate: '225deg' },
  left: { top: '50%', left: '8%', rotate: '270deg' },
  'front-left': { top: '20%', left: '20%', rotate: '315deg' },
}
