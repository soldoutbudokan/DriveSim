/** Lesson/exam progress persisted per active profile (see persistence/store). */

export interface ProgressData {
  lessons: Record<string, { completed: boolean; bestFaults: number; at: number }>;
  exams: Array<{ at: number; score: number; passed: boolean }>;
}

export function emptyProgress(): ProgressData {
  return { lessons: {}, exams: [] };
}

let keyPrefix = 'drivesim.default';

/** Persistence layer points this at the active profile. */
export function setProgressNamespace(prefix: string): void {
  keyPrefix = prefix;
}

export function loadProgress(): ProgressData {
  try {
    const raw = localStorage.getItem(`${keyPrefix}.progress.v1`);
    if (raw) return { ...emptyProgress(), ...(JSON.parse(raw) as ProgressData) };
  } catch {
    /* fresh */
  }
  return emptyProgress();
}

export function saveProgress(p: ProgressData): void {
  try {
    localStorage.setItem(`${keyPrefix}.progress.v1`, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
