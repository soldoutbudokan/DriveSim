/**
 * DriveTest-style weighted scoring rubric. Faults deduct from their
 * assessment area; the overall mark is the weighted average. Any auto-fail
 * item or dangerous action fails the test regardless of points, exactly as
 * on the real G road test.
 */

import type { Fault, RubricCategory } from '../core/types';

export interface CategoryDef {
  id: RubricCategory;
  label: string;
  weight: number;
}

export const CATEGORIES: CategoryDef[] = [
  { id: 'start', label: 'Start / Pull-away', weight: 4 },
  { id: 'driving', label: 'Driving Along', weight: 20 },
  { id: 'intersections', label: 'Intersections', weight: 16 },
  { id: 'turns', label: 'Turns', weight: 12 },
  { id: 'laneChanges', label: 'Lane Changes', weight: 10 },
  { id: 'highway', label: 'Highway (merge · maintain · exit)', weight: 16 },
  { id: 'parking', label: 'Parking & Backing', weight: 10 },
  { id: 'roadside', label: 'Roadside / Hill Stop', weight: 6 },
  { id: 'observation', label: 'Observation (mirrors · blind spots)', weight: 6 },
];

export const DEDUCTION: Record<Fault['severity'], number> = {
  minor: 7,
  major: 20,
  dangerous: 40,
  autofail: 100,
};

export const PASS_MARK = 75;

export interface CategoryScore extends CategoryDef {
  score: number;
  faults: Fault[];
}

export interface Recommendation {
  lessonId: string;
  title: string;
  reason: string;
}

export interface ExamReport {
  passed: boolean;
  overall: number;
  categories: CategoryScore[];
  faults: Fault[];
  autoFail: Fault | null;
  dangerous: Fault[];
  recommendations: Recommendation[];
  durationS: number;
  distanceKm: number;
  observationScore: number;
  at: number;
}

const CATEGORY_LESSON: Record<RubricCategory, { lessonId: string; title: string }> = {
  start: { lessonId: 'basics', title: 'Vehicle Basics & Smoothness' },
  driving: { lessonId: 'basics', title: 'Vehicle Basics & Smoothness' },
  intersections: { lessonId: 'intersections', title: 'Intersections & Right-of-Way' },
  turns: { lessonId: 'intersections', title: 'Intersections & Right-of-Way' },
  laneChanges: { lessonId: 'roundabout', title: 'Roundabout & Lane Changes' },
  highway: { lessonId: 'highway', title: 'Highway 401' },
  parking: { lessonId: 'maneuvers', title: 'Low-Speed Maneuvers' },
  roadside: { lessonId: 'maneuvers', title: 'Low-Speed Maneuvers' },
  observation: { lessonId: 'roundabout', title: 'Roundabout & Lane Changes (M·S·S ritual)' },
};

export function computeReport(
  faults: Fault[],
  observationScore: number,
  durationS: number,
  distanceKm: number,
): ExamReport {
  const categories: CategoryScore[] = CATEGORIES.map((c) => {
    const catFaults = faults.filter((f) => f.category === c.id);
    let deduction = 0;
    for (const f of catFaults) deduction += DEDUCTION[f.severity];
    let score = Math.max(0, 100 - deduction);
    if (c.id === 'observation') score = Math.min(score, Math.round(observationScore));
    return { ...c, score, faults: catFaults };
  });

  const totalWeight = CATEGORIES.reduce((a, c) => a + c.weight, 0);
  const overall = Math.round(categories.reduce((a, c) => a + c.score * c.weight, 0) / totalWeight);

  const autoFail = faults.find((f) => f.severity === 'autofail') ?? null;
  const dangerous = faults.filter((f) => f.severity === 'dangerous');
  const passed = !autoFail && dangerous.length === 0 && overall >= PASS_MARK;

  // prioritized practice: worst categories below 85, deduped by lesson
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();
  for (const c of [...categories].sort((a, b) => a.score - b.score)) {
    if (c.score >= 85 || recommendations.length >= 3) break;
    const map = CATEGORY_LESSON[c.id];
    if (seen.has(map.lessonId)) continue;
    seen.add(map.lessonId);
    const worst = c.faults.sort((a, b) => DEDUCTION[b.severity] - DEDUCTION[a.severity])[0];
    recommendations.push({
      lessonId: map.lessonId,
      title: map.title,
      reason: worst ? `${c.label}: ${worst.message.toLowerCase()}` : `${c.label} needs work (${c.score}%)`,
    });
  }

  return {
    passed,
    overall,
    categories,
    faults,
    autoFail,
    dangerous,
    recommendations,
    durationS,
    distanceKm,
    observationScore: Math.round(observationScore),
    at: Date.now(),
  };
}
