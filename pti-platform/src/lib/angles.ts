import type { AngleConfig } from './types'

export const INSPECTION_ANGLES: AngleConfig[] = [
  {
    key: 'front',
    label: 'FRONT',
    instruction: 'Stand directly in front. Frame the full nose, marker lights, and landing gear.',
    template: '/templates/front.png',
    order: 1,
  },
  {
    key: 'front-left-corner',
    label: 'FRONT LEFT CORNER',
    instruction: 'Move to the front-left corner. Capture the corner, air lines, and left front area.',
    template: '/templates/front-left-corner.png',
    order: 2,
  },
  {
    key: 'front-right-corner',
    label: 'FRONT RIGHT CORNER',
    instruction: 'Move to the front-right corner. Capture the corner, glad hands, and right front area.',
    template: '/templates/front-right-corner.png',
    order: 3,
  },
  {
    key: 'left-panel',
    label: 'LEFT PANEL',
    instruction: 'Stand at center-left. Capture the full length of the trailer from nose to rear.',
    template: '/templates/left-side.png',
    order: 4,
  },
  {
    key: 'back',
    label: 'BACK',
    instruction: 'Stand directly behind. Capture both rear doors, tail lights, and ICC bar.',
    template: '/templates/back.png',
    order: 5,
  },
  {
    key: 'back-right-corner',
    label: 'BACK RIGHT CORNER',
    instruction: 'Move to the rear-right corner. Capture rear axle tires, lights, and trailer corner.',
    template: '/templates/back-right-corner.png',
    order: 6,
  },
  {
    key: 'back-left-corner',
    label: 'BACK LEFT CORNER',
    instruction: 'Move to the rear-left corner. Capture rear axle tires, lights, and trailer corner.',
    template: '/templates/back-left-corner.png',
    order: 7,
  },
  {
    key: 'right-panel',
    label: 'RIGHT PANEL',
    instruction: 'Stand at center-right. Capture the full length of the trailer from nose to rear.',
    template: '/templates/right-side.png',
    order: 8,
  },
  {
    key: 'inside-overview',
    label: 'INSIDE OVERVIEW',
    instruction: 'Step inside and capture the full interior overview.',
    template: '/templates/inside-overview.png',
    order: 9,
  },
  {
    key: 'tire-fl',
    label: 'FRONT LEFT\nOUTSIDE TIRES',
    instruction: 'Photograph the front-left outside tires. Show tread depth and full sidewall.',
    template: null,
    order: 10,
  },
  {
    key: 'tire-bl',
    label: 'BACK LEFT\nOUTSIDE TIRES',
    instruction: 'Photograph the back-left outside tires. Show tread depth and full sidewall.',
    template: null,
    order: 11,
  },
  {
    key: 'tire-fr',
    label: 'FRONT RIGHT\nOUTSIDE TIRES',
    instruction: 'Photograph the front-right outside tires. Show tread depth and full sidewall.',
    template: null,
    order: 12,
  },
  {
    key: 'tire-br',
    label: 'BACK RIGHT\nOUTSIDE TIRES',
    instruction: 'Photograph the back-right outside tires. Show tread depth and full sidewall.',
    template: null,
    order: 13,
  },
  {
    key: 'extras',
    label: 'ADDITIONAL PHOTOS',
    instruction: 'Take any additional photos of issues, damage, or areas of concern.',
    template: null,
    order: 14,
  },
]

// ─────────────────────────────────────────────────────────────
// TRUCK INSPECTION ANGLES
// Tractor-focused angles for a full truck inspection, using the
// dashed-outline framing guides in /templates/truck/.
// ─────────────────────────────────────────────────────────────

export const TRUCK_ANGLES: AngleConfig[] = [
  {
    key: 'front',
    label: 'FRONT OF TRUCK',
    instruction: 'Stand directly in front of the truck. Frame the full front: grille, bumper, mirrors, windshield.',
    template: '/templates/truck/front.png',
    order: 1,
  },
  {
    key: 'front-right-corner',
    label: 'FRONT RIGHT',
    instruction: 'Move to the front-right corner. Capture the front and right side together.',
    template: '/templates/truck/front_right.png',
    order: 2,
  },
  {
    key: 'front-left-corner',
    label: 'FRONT LEFT',
    instruction: 'Move to the front-left corner. Capture the front and left side together.',
    template: '/templates/truck/front_left.png',
    order: 3,
  },
  {
    key: 'left-panel',
    label: 'LEFT SIDE',
    instruction: 'Stand at the left side. Capture the full length of the truck.',
    template: '/templates/truck/left_side.png',
    order: 4,
  },
  {
    key: 'back',
    label: 'BACK SIDE',
    instruction: 'Stand directly behind. Capture the rear: doors, lights, ICC bar, mudflaps.',
    template: '/templates/truck/back_side.png',
    order: 5,
  },
  {
    key: 'back-left-corner',
    label: 'BACK LEFT SIDE',
    instruction: 'Move to the rear-left corner. Capture the rear and left side together.',
    template: '/templates/truck/back_left_side.png',
    order: 6,
  },
  {
    key: 'back-right-corner',
    label: 'BACK RIGHT SIDE',
    instruction: 'Move to the rear-right corner. Capture the rear and right side together.',
    template: '/templates/truck/back_right_side.png',
    order: 7,
  },
  {
    key: 'right-panel',
    label: 'RIGHT SIDE',
    instruction: 'Stand at the right side. Capture the full length of the truck.',
    template: '/templates/truck/right_side.png',
    order: 8,
  },
  {
    key: 'inside-overview',
    label: 'CAB INTERIOR',
    instruction: 'Open the driver door and capture the cab interior: dash, seats, sleeper area.',
    template: null,
    order: 9,
  },
  {
    key: 'tire-fl',
    label: 'STEER TIRES\nLEFT',
    instruction: 'Photograph the left steer tire. Show tread depth and full sidewall.',
    template: null,
    order: 10,
  },
  {
    key: 'tire-fr',
    label: 'STEER TIRES\nRIGHT',
    instruction: 'Photograph the right steer tire. Show tread depth and full sidewall.',
    template: null,
    order: 11,
  },
  {
    key: 'tire-bl',
    label: 'DRIVE TIRES\nLEFT',
    instruction: 'Photograph the left drive tires. Show tread depth and full sidewall.',
    template: null,
    order: 12,
  },
  {
    key: 'tire-br',
    label: 'DRIVE TIRES\nRIGHT',
    instruction: 'Photograph the right drive tires. Show tread depth and full sidewall.',
    template: null,
    order: 13,
  },
  {
    key: 'extras',
    label: 'ADDITIONAL PHOTOS',
    instruction: 'Take any additional photos of issues, damage, or areas of concern.',
    template: null,
    order: 14,
  },
]

// Pick the right angle set for the inspection type.
export function getAngles(type?: string): AngleConfig[] {
  return type === 'TRUCK' ? TRUCK_ANGLES : INSPECTION_ANGLES
}
