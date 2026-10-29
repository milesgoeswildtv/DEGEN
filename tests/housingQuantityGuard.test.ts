import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateHousingPlacements } from '../worker/housingQuantityGuard.ts';

const owned = [{ item_key: 'starter-bed', quantity: 1 }];
const bed = (id: string, x: number, y = 1) => ({ instanceId: id, furnitureId: 'starter-bed', x, y });

test('one owned copy permits exactly one placement', () => {
  assert.equal(validateHousingPlacements(owned, [bed('a', 1)]).length, 1);
  assert.throws(() => validateHousingPlacements(owned, [bed('a', 1), bed('b', 2)]), /owned quantity/);
});
test('multiple server inventory rows aggregate without trusting client inventory', () => {
  const rows = [{item_key:'starter-bed',quantity:1},{item_key:'starter-bed',quantity:1}];
  assert.equal(validateHousingPlacements(rows, [bed('a',1),bed('b',2)]).length, 2);
  assert.throws(() => validateHousingPlacements(rows, [bed('a',1),bed('b',2),bed('c',3)]), /owned quantity/);
});
test('unowned furniture fails closed', () => {
  assert.throws(() => validateHousingPlacements([], [bed('a', 1)]), /owned quantity/);
});
test('duplicate placement IDs and occupied cells fail closed', () => {
  const rows = [{item_key:'starter-bed',quantity:3}];
  assert.throws(() => validateHousingPlacements(rows, [bed('a',1),bed('a',2)]), /Duplicate/);
  assert.throws(() => validateHousingPlacements(rows, [bed('a',1),bed('b',1)]), /Duplicate/);
});
test('invalid coordinates, rotation and malformed array entries fail closed', () => {
  for (const x of [-1,8,1.2,NaN,Infinity]) assert.throws(() => validateHousingPlacements(owned,[bed('a',x)]), /Invalid/);
  for (const y of [-1,6,1.2,NaN,Infinity]) assert.throws(() => validateHousingPlacements(owned,[bed('a',1,y)]), /Invalid/);
  assert.throws(() => validateHousingPlacements(owned,[{...bed('a',1),rotation:1.5}]), /Invalid/);
  for (const invalid of [null,0,true,{},'invalid']) assert.throws(() => validateHousingPlacements(owned,[invalid]), /Invalid/);
});
test('missing placements is not an intentional clear, but [] is', () => {
  assert.throws(() => validateHousingPlacements(owned,undefined), /must be an array/);
  assert.throws(() => validateHousingPlacements(owned,{}), /must be an array/);
  assert.deepEqual(validateHousingPlacements(owned,[]),[]);
});
test('inventory corruption and overflow fail closed', () => {
  for (const quantity of [-1,0.5,NaN,Infinity]) assert.throws(() => validateHousingPlacements([{item_key:'starter-bed',quantity}],[]), /quantity/);
  assert.throws(() => validateHousingPlacements([{item_key:'starter-bed',quantity:Number.MAX_SAFE_INTEGER},{item_key:'starter-bed',quantity:1}],[]), /quantity/);
});
test('grid capacity bound and exact 8x6 grid', () => {
  const all = Array.from({length:48},(_,i) => ({instanceId:'id-'+i,furnitureId:'starter-bed',x:i%8,y:Math.floor(i/8)}));
  assert.equal(validateHousingPlacements([{item_key:'starter-bed',quantity:48}],all).length,48);
  assert.throws(() => validateHousingPlacements([{item_key:'starter-bed',quantity:49}],[...all,bed('extra',1)]), /capacity/);
});
test('Worker handler validates complete layout before D1 batch', () => {
  const source=readFileSync(new URL('../worker/index.ts',import.meta.url),'utf8');
  const start=source.indexOf('async function handleHousing(');
  const end=source.indexOf('async function handleStartBattle(',start);
  const handler=source.slice(start,end);
  assert.ok(start>=0 && end>start);
  assert.ok(handler.indexOf('validateHousingPlacements(')>=0);
  assert.ok(handler.indexOf('validateHousingPlacements(')<handler.indexOf('await env.DB.batch(['));
  assert.match(handler,/typeof input.playerId !== 'string'/);
});
