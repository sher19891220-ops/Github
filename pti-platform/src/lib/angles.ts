import type { AngleConfig, AngleKey } from './types'

export const INSPECTION_ANGLES: AngleConfig[] = [
  {
    key: 'front',
    label: 'FRONT',
    instruction: 'Stand directly in front of the trailer. Frame the full nose, marker lights, and landing gear.',
    order: 1,
  },
  {
    key: 'front-right',
    label: 'FRONT RIGHT',
    instruction: 'Move to the front-right corner. Capture the corner, glad hands, and right front area.',
    order: 2,
  },
  {
    key: 'right',
    label: 'RIGHT SIDE',
    instruction: 'Stand at center-right. Capture the full length of the trailer from nose to rear doors.',
    order: 3,
  },
  {
    key: 'rear-right',
    label: 'REAR RIGHT',
    instruction: 'Move to the rear-right corner. Capture rear axle tires, lights, and trailer corner.',
    order: 4,
  },
  {
    key: 'rear',
    label: 'REAR',
    instruction: 'Stand directly behind the trailer. Capture both rear doors, tail lights, and ICC bar.',
    order: 5,
  },
  {
    key: 'rear-left',
    label: 'REAR LEFT',
    instruction: 'Move to the rear-left corner. Capture rear axle tires, lights, and trailer corner.',
    order: 6,
  },
  {
    key: 'left',
    label: 'LEFT SIDE',
    instruction: 'Stand at center-left. Capture the full length of the trailer from nose to rear doors.',
    order: 7,
  },
  {
    key: 'front-left',
    label: 'FRONT LEFT',
    instruction: 'Move to the front-left corner. Capture the corner, air lines, and left front area.',
    order: 8,
  },
  {
    key: 'inside-roof',
    label: 'INSIDE ROOF',
    instruction: 'Step inside and aim camera upward. Capture the full ceiling, roof bows, and any damage.',
    order: 9,
  },
  {
    key: 'floor',
    label: 'FLOOR',
    instruction: 'Aim camera downward at the floor. Capture full floor boards and any damage or moisture.',
    order: 10,
  },
  {
    key: 'inside-left-wall',
    label: 'LEFT WALL',
    instruction: 'Face the left interior wall. Capture the full wall surface, lining, and any damage.',
    order: 11,
  },
  {
    key: 'inside-right-wall',
    label: 'RIGHT WALL',
    instruction: 'Face the right interior wall. Capture the full wall surface, lining, and any damage.',
    order: 12,
  },
  {
    key: 'damage',
    label: 'DAMAGE',
    instruction: 'Photograph any damage, dents, or issues found. Take as many photos as needed.',
    order: 13,
  },
]

export const ANGLE_POSITIONS: Record<AngleKey, { top: string; left: string; rotate: string }> = {
  front:               { top: '8%',  left: '50%', rotate: '0deg'   },
  'front-right':       { top: '20%', left: '80%', rotate: '45deg'  },
  right:               { top: '50%', left: '92%', rotate: '90deg'  },
  'rear-right':        { top: '80%', left: '80%', rotate: '135deg' },
  rear:                { top: '92%', left: '50%', rotate: '180deg' },
  'rear-left':         { top: '80%', left: '20%', rotate: '225deg' },
  left:                { top: '50%', left: '8%',  rotate: '270deg' },
  'front-left':        { top: '20%', left: '20%', rotate: '315deg' },
  'inside-roof':       { top: '50%', left: '50%', rotate: '0deg'   },
  floor:               { top: '50%', left: '50%', rotate: '0deg'   },
  'inside-left-wall':  { top: '50%', left: '50%', rotate: '0deg'   },
  'inside-right-wall': { top: '50%', left: '50%', rotate: '0deg'   },
  damage:              { top: '50%', left: '50%', rotate: '0deg'   },
}
