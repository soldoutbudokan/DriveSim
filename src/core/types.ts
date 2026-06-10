/** Shared primitive types used across modules. Keep this dependency-free. */

export type WeatherKind = 'clear' | 'rain' | 'fog' | 'snow';

export type Severity = 'minor' | 'major' | 'dangerous' | 'autofail';

/** DriveTest-style assessment areas used by the rubric and the fault log. */
export type RubricCategory =
  | 'start'
  | 'driving'
  | 'intersections'
  | 'turns'
  | 'laneChanges'
  | 'highway'
  | 'parking'
  | 'roadside'
  | 'observation';

export interface Fault {
  /** Stable code, e.g. 'no-shoulder-check'. */
  code: string;
  category: RubricCategory;
  severity: Severity;
  message: string;
  /** Sim time in seconds when the fault occurred. */
  time: number;
  x: number;
  z: number;
}

export interface CoachMessage {
  kind: 'info' | 'warn' | 'good';
  text: string;
  time: number;
}

export type CameraMode = 'chase' | 'cockpit' | 'top';

export type DriveMode = 'free' | 'lesson' | 'exam' | 'replay';

export interface QualitySettings {
  tier: 'low' | 'medium' | 'high' | 'ultra' | 'auto';
  resolvedTier: 'low' | 'medium' | 'high' | 'ultra';
}

export interface GameEvents extends Record<string, unknown> {
  fault: Fault;
  coach: CoachMessage;
  collision: { impulse: number; x: number; z: number; kind: string };
  signal: { side: 'left' | 'right' | 'off'; auto: boolean };
  check: { kind: 'mirror' | 'shoulderLeft' | 'shoulderRight'; time: number };
  horn: { on: boolean };
  gear: { gear: string };
  objective: { text: string; sub?: string };
  toastClear: Record<string, never>;
}
