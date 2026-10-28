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

test('stage time limits get shorter and every stage has one', () => {
  assert.strictEqual(L.stageMs(1), 60000);
  for (let k = 2; k <= L.STAGE_SEC.length; k++) assert.ok(L.stageMs(k) < L.stageMs(k - 1), `stage ${k} is shorter`);
  assert.strictEqual(L.stageMs(0), L.stageMs(1), 'below 1 clamps');
  assert.strictEqual(L.stageMs(99), L.stageMs(L.STAGE_SEC.length), 'above the last clamps');
});

test('combo multiplier grows every five and stops at the cap', () => {
  assert.deepStrictEqual([0, 4, 5, 9, 10, 19, 20, 24, 25, 99].map(L.comboMult), [1, 1, 2, 2, 3, 4, 5, 5, 5, 5]);
});

test('solo taps score ten each and the combo raises the multiplier', () => {
  const g = L.newSolo(1, seeded(3));
  let total = 0;
  for (let n = 1; n <= 10; n++) { const r = L.soloTap(g, cellOf(g, n), 1000 + n); assert.strictEqual(r.kind, 'ok'); total += r.points; }
  // 숫자 1~5 는 x1(10점), 6~10 은 x2(20점)
  assert.strictEqual(total, 5 * 10 + 5 * 20);
  assert.strictEqual(g.score, total);
  assert.strictEqual(g.combo, 10);
});

test('a wrong tap in solo breaks the combo, locks, and scores nothing', () => {
  const g = L.newSolo(1, seeded(4));
  for (let n = 1; n <= 6; n++) L.soloTap(g, cellOf(g, n), 100);
  const before = g.score;
  const r = L.soloTap(g, cellOf(g, 20), 200);
  assert.strictEqual(r.kind, 'wrong');
  assert.strictEqual(g.combo, 0);
  assert.strictEqual(g.maxCombo, 6, 'best combo is remembered');
  assert.strictEqual(g.score, before);
  assert.strictEqual(L.soloTap(g, cellOf(g, 7), 200 + L.WRONG_LOCK_MS - 1).kind, 'ignored', 'locked');
  const ok = L.soloTap(g, cellOf(g, 7), 200 + L.WRONG_LOCK_MS);
  assert.deepStrictEqual([ok.kind, ok.points], ['ok', 10], 'multiplier starts over');
});

test('finishing the board clears the stage and remaining time adds 100 per second', () => {
  const g = L.newSolo(2, seeded(6));
  let last;
  for (let n = 1; n <= 25; n++) last = L.soloTap(g, cellOf(g, n), 10 + n);
  assert.strictEqual(last.kind, 'clear');
  assert.ok(g.over && g.cleared);
  const base = g.score;
  assert.strictEqual(L.soloClear(g, 12340), 1234);
  assert.strictEqual(g.score, base + 1234);
  assert.strictEqual(L.clearBonus(-5), 0, 'no negative bonus');
  assert.strictEqual(L.soloTap(g, 0, 99999).kind, 'ignored', 'finished board takes no more taps');
});

test('the combo and score carry into the next stage', () => {
  const g = L.newSolo(1, seeded(8));
  for (let n = 1; n <= 25; n++) L.soloTap(g, cellOf(g, n), n);
  const h = L.newSolo(2, seeded(9), g);
  assert.strictEqual(h.stage, 2);
  assert.strictEqual(h.score, g.score);
  assert.strictEqual(h.combo, 25);
  assert.strictEqual(h.next, 1);
});

test('solo garbage taps are ignored', () => {
  const g = L.newSolo(1, seeded(2));
  for (const c of [-1, 25, 1.5, NaN, '3', null, undefined]) assert.strictEqual(L.soloTap(g, c, 1).kind, 'ignored');
  assert.strictEqual(g.next, 1);
});
