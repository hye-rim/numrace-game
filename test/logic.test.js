'use strict';

// 숫자 레이스 규칙 시험. 실행: npm test (node --test)
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/logic.js');

// 고정 난수 (확률이 걸린 시험은 항상 같은 결과가 나오게)
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const cellOf = (g, n) => g.board.indexOf(n);

test('every shuffled board holds each of 1 to 25 exactly once', () => {
  const rng = seeded(5);
  for (let k = 0; k < 200; k++) {
    const b = L.shuffleBoard(rng);
    assert.strictEqual(b.length, 25);
    assert.deepStrictEqual([...b].sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
  }
  assert.notDeepStrictEqual(L.shuffleBoard(seeded(1)), L.shuffleBoard(seeded(2)), 'different seeds give different boards');
});

test('boards are actually mixed up (not left in order)', () => {
  const rng = seeded(11);
  let inOrder = 0;
  for (let k = 0; k < 100; k++) if (L.shuffleBoard(rng).every((v, i) => v === i + 1)) inOrder++;
  assert.strictEqual(inOrder, 0);
});

test('tapping the numbers in order advances and finishes at 25', () => {
  const g = L.newRace(seeded(3));
  for (let n = 1; n <= 25; n++) {
    assert.strictEqual(g.next[0], n);
    const r = L.tap(g, 0, cellOf(g, n), 1000 + n);
    assert.strictEqual(r.kind, n === 25 ? 'finish' : 'ok');
  }
  assert.strictEqual(g.over, true);
  assert.strictEqual(g.winner, 0);
  assert.strictEqual(g.reason, 'finish');
  assert.strictEqual(g.next[1], 1, 'the other side did not move');
});

test('a wrong number locks that player for a moment and counts the mistake', () => {
  const g = L.newRace(seeded(4));
  const r = L.tap(g, 0, cellOf(g, 5), 1000);
  assert.strictEqual(r.kind, 'wrong');
  assert.strictEqual(g.wrong[0], 1);
  assert.strictEqual(g.next[0], 1);
  assert.strictEqual(L.tap(g, 0, cellOf(g, 1), 1000 + L.WRONG_LOCK_MS - 1).kind, 'ignored', 'still locked');
  assert.strictEqual(g.next[0], 1);
  assert.strictEqual(L.tap(g, 0, cellOf(g, 1), 1000 + L.WRONG_LOCK_MS).kind, 'ok', 'unlocked');
  assert.strictEqual(g.next[0], 2);
  assert.strictEqual(L.tap(g, 1, cellOf(g, 1), 1001).kind, 'ok', 'the other player is not locked');
});

test('pressing a number already passed does nothing and costs nothing', () => {
  const g = L.newRace(seeded(6));
  L.tap(g, 0, cellOf(g, 1), 100); L.tap(g, 0, cellOf(g, 2), 200);
  assert.strictEqual(L.tap(g, 0, cellOf(g, 1), 300).kind, 'done');
  assert.strictEqual(g.wrong[0], 0);
  assert.strictEqual(L.tap(g, 0, cellOf(g, 3), 301).kind, 'ok', 'no lock after a repeat tap');
});

test('the two players race on the same board independently and the first to 25 wins', () => {
  const g = L.newRace(seeded(8));
  let t = 0;
  for (let n = 1; n <= 24; n++) { L.tap(g, 0, cellOf(g, n), ++t); L.tap(g, 1, cellOf(g, n), ++t); }
  assert.strictEqual(g.over, false);
  assert.strictEqual(L.tap(g, 1, cellOf(g, 25), ++t).kind, 'finish');
  assert.strictEqual(g.winner, 1);
  assert.strictEqual(L.tap(g, 0, cellOf(g, 25), ++t).kind, 'ignored', 'nothing counts after the end');
  assert.strictEqual(g.winner, 1);
  assert.strictEqual(g.next[0], 25);
});

test('garbage taps are ignored', () => {
  const g = L.newRace(seeded(9));
  for (const [who, cell] of [[0, -1], [0, 25], [0, 1.5], [0, '3'], [0, null], [0, undefined], [2, 3], [-1, 3], ['0', 3], [0, NaN], [0, Infinity]]) {
    assert.strictEqual(L.tap(g, who, cell, 1000).kind, 'ignored', `${who},${cell}`);
  }
  assert.deepStrictEqual(g.next, [1, 1]);
  assert.deepStrictEqual(g.wrong, [0, 0]);
});

test('time up: the one who got further wins, equal is a draw', () => {
  const a = L.newRace(seeded(1));
  L.tap(a, 0, cellOf(a, 1), 1); L.tap(a, 0, cellOf(a, 2), 2); L.tap(a, 1, cellOf(a, 1), 3);
  L.timeUp(a);
  assert.strictEqual(a.over, true); assert.strictEqual(a.winner, 0); assert.strictEqual(a.reason, 'timeout');
  const b = L.newRace(seeded(2)); L.timeUp(b);
  assert.strictEqual(b.winner, 2);
  const c = L.newRace(seeded(3));
  L.tap(c, 1, cellOf(c, 1), 1);
  L.timeUp(c);
  assert.strictEqual(c.winner, 1);
  L.timeUp(c);                                              // 두 번 불러도 그대로
  assert.strictEqual(c.winner, 1);
});

test('computer delay stays in range and hard is faster than easy', () => {
  const rng = seeded(21);
  let easy = 0, hard = 0;
  for (let k = 0; k < 500; k++) {
    const e = L.botDelay('easy', rng), h = L.botDelay('hard', rng);
    assert.ok(e >= L.BOT.easy[0] - L.BOT.easy[1] - 1 && e <= L.BOT.easy[0] + L.BOT.easy[1] + 1);
    assert.ok(h >= L.BOT.hard[0] - L.BOT.hard[1] - 1 && h <= L.BOT.hard[0] + L.BOT.hard[1] + 1);
    easy += e; hard += h;
  }
  assert.ok(hard < easy);
  assert.ok(L.botDelay('nope', rng) >= 250, 'unknown level falls back');
});

test('hard computer beats easy in simulated races (seeded)', () => {
  const rng = seeded(77);
  let hardWins = 0;
  for (let k = 0; k < 100; k++) {
    let ta = 0, tb = 0;                                      // 각자 25 개를 누르는 데 걸린 시간
    for (let n = 0; n < 25; n++) { ta += L.botDelay('hard', rng); tb += L.botDelay('easy', rng); }
    if (ta < tb) hardWins++;
  }
  assert.ok(hardWins >= 95, `hard won ${hardWins}/100`);
});
