import type { BattlePermit, WorldEventSnapshot } from '../domain/types';

const KEY = 'degen.preview.underpass.v1';
const FULL_REWARD_LIMIT = 3;

interface StoredCycle {
  cycleId: string;
  opensAt: string;
  closesAt: string;
  fullRewardClears: number;
}

const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const createCycle = (now = Date.now()): StoredCycle => {
  const closedMinutes = randomInt(120, 240);
  const openMinutes = randomInt(60, 90);
  const opensAt = now + closedMinutes * 60_000;
  return {
    cycleId: crypto.randomUUID(),
    opensAt: new Date(opensAt).toISOString(),
    closesAt: new Date(opensAt + openMinutes * 60_000).toISOString(),
    fullRewardClears: 0,
  };
};

const loadCycle = (): StoredCycle => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as StoredCycle | null;
    if (parsed && Date.parse(parsed.closesAt) > Date.now()) return parsed;
  } catch {
    // Roll a new preview cycle below.
  }
  const cycle = createCycle();
  localStorage.setItem(KEY, JSON.stringify(cycle));
  return cycle;
};

const devForcedOpen = (): boolean =>
  new URLSearchParams(window.location.search).get('dev') === 'open';

export const getPreviewUnderpass = (): WorldEventSnapshot => {
  const cycle = loadCycle();
  const now = Date.now();
  const opens = Date.parse(cycle.opensAt);
  const closes = Date.parse(cycle.closesAt);
  const forced = devForcedOpen();
  const phase = forced
    ? 'open'
    : now >= opens && now < closes
      ? 'open'
      : opens - now <= 15 * 60_000
        ? 'warning'
        : 'sealed';

  return {
    eventKey: 'underpass',
    cycleId: cycle.cycleId,
    phase,
    opensAt: forced ? new Date(now - 60_000).toISOString() : cycle.opensAt,
    closesAt: forced ? new Date(now + 75 * 60_000).toISOString() : cycle.closesAt,
    fullRewardClears: cycle.fullRewardClears,
    fullRewardLimit: FULL_REWARD_LIMIT,
    source: 'preview',
  };
};

export const createPreviewPermit = (cycleId: string): BattlePermit => ({
  permitId: `preview-${crypto.randomUUID()}`,
  eventKey: 'underpass',
  cycleId,
  encounterKey: 'tunnel-maw',
  expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
});

export const recordPreviewClear = (): number => {
  const cycle = loadCycle();
  const previous = cycle.fullRewardClears;
  cycle.fullRewardClears += 1;
  localStorage.setItem(KEY, JSON.stringify(cycle));
  return previous;
};
