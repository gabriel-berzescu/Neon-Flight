/**
 * The player's settings, kept in the browser (localStorage, per site: the Pages site and play.bat keep their own).
 *
 *   quality   'auto' (src/render/quality.ts adapts to the GPU) or a fixed level, an index into QUALITY
 *   roll      how fast full stick rolls: 'glide' 60 deg/s, 'cruise' 100, 'sport' 150 (the default since 10-26) or 'fighter'
 *             230 (the first tuning); named gentle / calm / sharp before 10-27, read back as cruise / sport / fighter
 *   volume    master sound volume, 0..1
 *   fpm       the flight-path marker on the HUD
 */
export interface Settings {
  quality: 'auto' | number;
  roll: 'glide' | 'cruise' | 'sport' | 'fighter';
  volume: number;
  fpm: boolean;
}

export const DEFAULT_SETTINGS: Settings = { quality: 'auto', roll: 'sport', volume: 0.8, fpm: true };

/** Full-stick roll rate (rad/s) for each roll setting: fcs/roll-rate-max in the aircraft's fly-by-wire. */
export const ROLL_RATE: Record<Settings['roll'], number> = { glide: 1.05, cruise: 1.75, sport: 2.6, fighter: 4.0 };

/** The roll settings in the order the menu steps through them, with their labels. */
export const ROLL_LABEL: Record<Settings['roll'], string> = {
  glide: 'glide (60°/s)', cruise: 'cruise (100°/s)', sport: 'sport (150°/s)', fighter: 'fighter (230°/s)',
};
const ROLLS = Object.keys(ROLL_RATE) as Settings['roll'][];
/** The roll settings' earlier names. */
const OLD_ROLL: Record<string, Settings['roll']> = { gentle: 'cruise', calm: 'sport', sharp: 'fighter' };

export function nextRoll(r: Settings['roll']): Settings['roll'] {
  return ROLLS[(ROLLS.indexOf(r) + 1) % ROLLS.length];
}

const KEY = 'neon-flight.settings';

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_SETTINGS };
    const s = { ...DEFAULT_SETTINGS, ...saved };
    if (s.quality !== 'auto' && !(typeof s.quality === 'number' && s.quality >= 0 && s.quality <= 3)) s.quality = 'auto';
    s.roll = OLD_ROLL[s.roll] ?? s.roll;
    if (!ROLLS.includes(s.roll)) s.roll = DEFAULT_SETTINGS.roll;
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
