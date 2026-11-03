import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { BattleEngine } from '../src/game/combat/engine.ts';
import { assertNoMonsterActionResource, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { battleView, updateBattleDom } from '../src/ui/views.ts';
import type { BattleSnapshot } from '../src/game/combat/engine.ts';

const slash = TEST_DEGEN.abilities.find((ability) => ability.id === 'slash');
assert.ok(slash);
const shieldedEnemy = { ...TUNNEL_MAW, startingShield: 5 };

test('enemy Shield absorbs Degen damage before HP and still permits retaliation', () => {
  const result = resolveCombatTurn({
    playerHp: 50, playerMana: 0, playerShield: 0,
    enemyHp: TUNNEL_MAW.maxHp, enemyShield: 5,
    ability: slash, degen: TEST_DEGEN, enemy: shieldedEnemy,
  });
  assert.equal(result.playerDamage, slash.damage + Math.floor(TEST_DEGEN.power * 0.5));
  assert.equal(result.enemyShieldAbsorbed, 5);
  assert.equal(result.enemyShield, 0);
  assert.equal(result.enemyHp, TUNNEL_MAW.maxHp - (result.playerDamage - 5));
  assert.equal(result.status, 'active');
  assert.ok(result.retaliationDamage > 0);
});

test('enemy Shield carries across turns and a killing blow consumes it before HP', () => {
  const carried = resolveCombatTurn({
    playerHp: 50, playerMana: 0, enemyHp: TUNNEL_MAW.maxHp, enemyShield: 40,
    ability: slash, degen: TEST_DEGEN, enemy: shieldedEnemy,
  });
  assert.equal(carried.enemyShieldAbsorbed, carried.playerDamage);
  assert.equal(carried.enemyShield, 40 - carried.playerDamage);
  assert.equal(carried.enemyHp, TUNNEL_MAW.maxHp);

  const killing = resolveCombatTurn({
    playerHp: 5, playerMana: 0, enemyHp: 1, enemyShield: 5,
    ability: slash, degen: TEST_DEGEN, enemy: shieldedEnemy,
  });
  assert.equal(killing.status, 'victory');
  assert.equal(killing.enemyShield, 0);
  assert.equal(killing.enemyHp, 0);
  assert.equal(killing.retaliationDamage, 0);
});

test('invalid enemy starting Shield values fail closed while Shield is not a forbidden monster resource', () => {
  for (const startingShield of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, null as unknown as number]) {
    const invalid = { ...TUNNEL_MAW, startingShield };
    assert.throws(() => new BattleEngine(TEST_DEGEN, invalid, () => undefined), /Invalid enemy starting Shield/);
  }
  assert.doesNotThrow(() => assertNoMonsterActionResource(shieldedEnemy));
});

test('BattleEngine carries and displays enemy starting Shield without local reversion or reward changes', () => {
  const engine = new BattleEngine(TEST_DEGEN, shieldedEnemy, () => undefined);
  assert.equal(engine.snapshot.enemyShield, 5);
  engine.useAbility('slash');
  assert.equal(engine.snapshot.enemyShield, undefined);
  assert.equal(engine.snapshot.enemyHp, TUNNEL_MAW.maxHp - (slash.damage + Math.floor(TEST_DEGEN.power * 0.5) - 5));
  assert.match(engine.snapshot.log.join(' '), /Tunnel Maw Shield absorbs 5/);
});

test('battle DOM exposes enemy Shield only when present and includes it in the accessible HUD', () => {
  const markup = battleView({
    id: 'enemy-shield-player', displayName: 'Shield Tester', level: 1, xp: 0, currency: 0,
    degenId: TEST_DEGEN.id, inventory: [], unlockedLocations: ['home'],
    housing: { inventory: [], placements: [] }, defeatedBosses: [],
  } as never, TEST_DEGEN);
  assert.match(markup, /id="battle-enemy-shield"[^>]*hidden/);

  const elements = new Map<string, { textContent: string; hidden?: boolean; innerHTML?: string }>([
    ['#battle-accessible-hud', { textContent: '' }],
    ['#battle-mana', { textContent: '' }],
    ['#battle-shield', { textContent: '' }],
    ['#battle-enemy-shield', { textContent: 'ENEMY SHIELD 0', hidden: true }],
    ['#battle-log', { textContent: '', innerHTML: '' }],
  ]);
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: () => [],
  } as unknown as Document;
  try {
    const snapshot: BattleSnapshot = {
      status: 'active', playerName: TEST_DEGEN.name, playerHp: TEST_DEGEN.maxHp,
      playerMaxHp: TEST_DEGEN.maxHp, playerMana: 0, playerMaxMana: TEST_DEGEN.maxMana,
      playerShield: 0, turnCount: 1, enemyName: shieldedEnemy.name, enemyLevel: shieldedEnemy.level,
      enemyHp: shieldedEnemy.maxHp, enemyMaxHp: shieldedEnemy.maxHp, enemyShield: 5, log: [],
    };
    updateBattleDom(snapshot);
    assert.equal(elements.get('#battle-enemy-shield')?.textContent, 'ENEMY SHIELD 5');
    assert.equal(elements.get('#battle-enemy-shield')?.hidden, false);
    assert.match(elements.get('#battle-accessible-hud')?.textContent ?? '', /Tunnel Maw: HP .* Shield 5/);
    updateBattleDom({ ...snapshot, enemyShield: 0 });
    assert.equal(elements.get('#battle-enemy-shield')?.hidden, true, 'zero enemy Shield is not shown as a false active resource');
    assert.doesNotMatch(
      elements.get('#battle-accessible-hud')?.textContent ?? '',
      /Tunnel Maw: HP .* Shield 0/,
      'zero enemy Shield must not be announced as an active resource',
    );
    updateBattleDom({ ...snapshot, enemyShield: undefined });
    assert.equal(elements.get('#battle-enemy-shield')?.hidden, true, 'missing enemy Shield remains hidden');
  } finally {
    globalThis.document = originalDocument;
  }
});
