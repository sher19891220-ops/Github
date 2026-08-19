import type { EventType, MvrEvent, ViolationSeverity } from './types';

/**
 * Description-based classification of MVR records.
 *
 * Two rules govern this module:
 *
 *  1. A record is only classified when its description matches a known pattern.
 *     Anything unmatched stays `Unknown`, which the engine treats as a data gap
 *     (Manual Review), never as a minor moving violation.
 *  2. Points are corroborating evidence only. A zero-point record is not
 *     automatically administrative, and a pointed record is not automatically a
 *     moving violation — real MVRs carry pointed administrative records and
 *     zero-point moving violations in some states.
 */

export interface ClassificationRule {
  id: string;
  label: string;
  pattern: RegExp;
  eventType: EventType;
  severity: ViolationSeverity;
}

/**
 * Non-driving/administrative records. These never count as moving violations
 * unless the applicable Auto Liability guideline names them explicitly.
 */
export const ADMINISTRATIVE_RULES: ClassificationRule[] = [
  { id: 'admin.abandoned_vehicle', label: 'Abandoned vehicle fee', pattern: /\babandoned\s+vehicle\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.fee_due', label: 'Fee due', pattern: /\bfees?\s+due\b|\bdue\s+fees?\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.fail_to_appear', label: 'Failure to appear / court entry', pattern: /\b(fail(ure|ed)?\s+to\s+appear|fta)\b|\btrial\s*\/?\s*court\b|\bcourt\s+entry\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.parking', label: 'Parking', pattern: /\bparking\b|\bparked\s+(vehicle|illegally)\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.toll', label: 'Toll', pattern: /\btolls?\b|\btoll\s+evasion\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.registration', label: 'Registration / reinstatement fee', pattern: /\bregistration\b|\breinstat\w*\s+fee\b|\breinstatement\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.insurance_proof', label: 'Proof of insurance / financial responsibility filing', pattern: /\b(proof\s+of\s+insurance|financial\s+responsibility)\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.equipment', label: 'Equipment / paperwork defect', pattern: /\b(defective|no)\s+(equipment|lights?|mudflaps?)\b|\bexpired\s+(plate|tag|sticker)s?\b/i, eventType: 'Administrative', severity: 'Unknown' },
  { id: 'admin.license_display', label: 'Failure to display / carry license', pattern: /\b(fail(ure|ed)?\s+to\s+(display|carry|produce))\b/i, eventType: 'Administrative', severity: 'Unknown' },
];

/** Disqualifying-tier offences under 49 CFR 383.51 subpart B and common carrier lists. */
export const MAJOR_RULES: ClassificationRule[] = [
  { id: 'major.dui', label: 'DUI / DWI / OWI / OVI', pattern: /\b(dui|dwi|owi|oui|ovi)\b|\bunder\s+the\s+influence\b|\bintoxicat\w*\b|\bimpaired\s+driving\b|\bdriving\s+impaired\b|\bbac\b/i, eventType: 'Moving Violation', severity: 'Major' },
  { id: 'major.refusal', label: 'Refusal to submit to testing', pattern: /\brefus\w*\s+(to\s+)?(submit|test|chemical|breath|blood)\b|\bimplied\s+consent\b/i, eventType: 'Moving Violation', severity: 'Major' },
  { id: 'major.controlled_substance', label: 'Controlled substance while driving', pattern: /\bcontrolled\s+substance\b|\bdrug\s+possession\s+.*vehicle\b/i, eventType: 'Moving Violation', severity: 'Major' },
  { id: 'major.reckless', label: 'Reckless driving', pattern: /\breckless\b|\bcareless\s+and\s+wanton\b|\bwilful\s+disregard\b/i, eventType: 'Moving Violation', severity: 'Major' },
  { id: 'major.leaving_scene', label: 'Leaving the scene / hit and run', pattern: /\b(leav\w*\s+the\s+scene|hit\s*(and|&)\s*run|hit\s*-?\s*skip)\b/i, eventType: 'Moving Violation', severity: 'Major' },
  { id: 'major.felony_vehicle', label: 'Felony involving a motor vehicle', pattern: /\bfelony\b|\bvehicular\s+(homicide|manslaughter|assault)\b/i, eventType: 'Moving Violation', severity: 'Major' },
  { id: 'major.driving_while_suspended', label: 'Driving while suspended / revoked', pattern: /\bdriving\s+(while|with|on|under)\s+.*\b(suspend\w*|revok\w*|disqualif\w*)\b|\bdws\b|\bdwlsr?\b/i, eventType: 'Moving Violation', severity: 'Major' },
  { id: 'major.fleeing', label: 'Fleeing or eluding', pattern: /\b(flee\w*|elud\w*)\b/i, eventType: 'Moving Violation', severity: 'Major' },
];

/** Serious traffic violations under 49 CFR 383.51(c). */
export const SERIOUS_RULES: ClassificationRule[] = [
  { id: 'serious.excessive_speed', label: 'Excessive speeding (15+ over)', pattern: /\bspeed\w*\s+.*\b(1[5-9]|[2-9]\d)\s*(mph\s*)?(or\s+more\s+)?over\b|\bexcessive\s+speed\b/i, eventType: 'Moving Violation', severity: 'Serious' },
  { id: 'serious.improper_lane', label: 'Improper or erratic lane change', pattern: /\b(improper|erratic|unsafe)\s+lane\b/i, eventType: 'Moving Violation', severity: 'Serious' },
  { id: 'serious.following_too_close', label: 'Following too closely', pattern: /\bfollow\w*\s+too\s+clos\w*\b|\btailgat\w*\b/i, eventType: 'Moving Violation', severity: 'Serious' },
  { id: 'serious.texting', label: 'Texting or handheld phone while driving', pattern: /\b(text\w*|handheld|hand-held|mobile\s+phone|cell\s*phone)\b/i, eventType: 'Moving Violation', severity: 'Serious' },
  { id: 'serious.no_cdl', label: 'Operating without a valid CDL in possession', pattern: /\b(without|no)\s+.*\bcdl\b|\bwrong\s+class\s+of\s+license\b/i, eventType: 'Moving Violation', severity: 'Serious' },
  { id: 'serious.railroad', label: 'Railroad crossing violation', pattern: /\brailroad\b|\bgrade\s+crossing\b/i, eventType: 'Moving Violation', severity: 'Serious' },
];

/** Ordinary moving violations. */
export const MINOR_RULES: ClassificationRule[] = [
  { id: 'minor.speeding', label: 'Speeding', pattern: /\bspeed\w*\b|\bexceed\w*\s+(posted|maximum)\b/i, eventType: 'Moving Violation', severity: 'Minor' },
  { id: 'minor.backing', label: 'Improper backing', pattern: /\bback(ing|ed|up)\b|\blimitations?\s+on\s+backing\b/i, eventType: 'Moving Violation', severity: 'Minor' },
  { id: 'minor.red_light', label: 'Disobeyed traffic signal', pattern: /\b(red\s+light|traffic\s+(signal|control\s+device)|stop\s+sign|disobey\w*\s+signal)\b/i, eventType: 'Moving Violation', severity: 'Minor' },
  { id: 'minor.right_of_way', label: 'Failure to yield right of way', pattern: /\b(yield|right\s+of\s+way)\b/i, eventType: 'Moving Violation', severity: 'Minor' },
  { id: 'minor.improper_turn', label: 'Improper turn', pattern: /\bimproper\s+turn\b|\billegal\s+u-?turn\b/i, eventType: 'Moving Violation', severity: 'Minor' },
  { id: 'minor.seatbelt', label: 'Seat belt', pattern: /\bseat\s*belt\b|\bsafety\s+belt\b/i, eventType: 'Moving Violation', severity: 'Minor' },
  { id: 'minor.lane_usage', label: 'Improper lane usage', pattern: /\blane\s+usage\b|\bimproper\s+passing\b|\bunsafe\s+start\b/i, eventType: 'Moving Violation', severity: 'Minor' },
];

export const ACCIDENT_RULES: ClassificationRule[] = [
  { id: 'accident.generic', label: 'Accident / collision', pattern: /\b(accident|collision|crash)\b/i, eventType: 'Accident', severity: 'Unknown' },
];

/**
 * Evaluation order matters. Administrative patterns run first so a court or fee
 * record is never captured by a broader driving pattern, then majors before
 * minors so "driving while suspended" outranks the generic license rules.
 */
export const CLASSIFICATION_RULES: ClassificationRule[] = [
  ...ADMINISTRATIVE_RULES,
  ...MAJOR_RULES,
  ...SERIOUS_RULES,
  ...ACCIDENT_RULES,
  ...MINOR_RULES,
];

export interface Classification {
  eventType: EventType;
  severity: ViolationSeverity;
  matchedRuleId: string | null;
  matchedRuleLabel: string | null;
}

export function classifyDescription(description: string): Classification {
  const text = (description ?? '').trim();
  if (!text) {
    return { eventType: 'Unknown', severity: 'Unknown', matchedRuleId: null, matchedRuleLabel: null };
  }
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(text)) {
      return {
        eventType: rule.eventType,
        severity: rule.severity,
        matchedRuleId: rule.id,
        matchedRuleLabel: rule.label,
      };
    }
  }
  return { eventType: 'Unknown', severity: 'Unknown', matchedRuleId: null, matchedRuleLabel: null };
}

/**
 * Classifies an extracted event, preserving a reviewer's confirmed override.
 * Automatic classification never overwrites a human decision.
 */
export function classifyEvent(event: MvrEvent): MvrEvent & { matchedRuleId: string | null } {
  if (event.reviewerConfirmed) {
    return { ...event, matchedRuleId: null };
  }
  const c = classifyDescription(event.description);
  return { ...event, eventType: c.eventType, severity: c.severity, matchedRuleId: c.matchedRuleId };
}

/**
 * Detects suspension language in free text. Used only to *warn* that a document
 * may contain a suspension record that extraction missed — never to create one.
 */
export function mentionsSuspension(text: string): boolean {
  return /\b(suspend\w*|revok\w*|disqualif\w*|withdraw\w*)\b/i.test(text ?? '');
}
