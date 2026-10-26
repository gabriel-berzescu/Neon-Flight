/**
 * The player's settings, kept in the browser (localStorage, per site: the Pages site and play.bat keep their own).
 *
 *   quality   'auto' (src/render/quality.ts adapts to the GPU) or a fixed level, an index into QUALITY
 *   roll      how fast full stick rolls: 'calm' 150 deg/s (the default since 10-26) or 'sharp' 230 deg/s (the first tuning)
 *   volume    master sound volume, 0..1
 *   fpm       the flight-path marker on the HUD
 */
export interface Settings {
  quality: 'auto' | number;
  roll: 'calm' | 'sharp';
  volume: number;
  fpm: boolean;
}

export const DEFAULT_SETTINGS: Settings = { quality: 'auto', roll: 'calm', volume: 0.8, fpm: true };

/** Full-stick roll rate (rad/s) for each roll setting: fcs/roll-rate-max in the aircraft's fly-by-wire. */
export const ROLL_RATE: Record<Settings['roll'], number> = { calm: 2.6, sharp: 4.0 };

const KEY = 'neon-flight.settings';

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_SETTINGS };
    const s = { ...DEFAULT_SETTINGS, ...saved };
    if (s.quality !== 'auto' && !(typeof s.quality === 'number' && s.quality >= 0 && s.quality <= 3)) s.quality = 'auto';
    if (s.roll !== 'calm' && s.roll !== 'sharp') s.roll = 'calm';
    s.volume = typeof s.volume === 'number' ? Math.max(0, Math.min(1, s.volume)) : DEFAULT_SETTINGS.volume;
    s.fpm = s.fpm !== false;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not kept: they apply for this visit
  }
}
