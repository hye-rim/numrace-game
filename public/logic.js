'use strict';
// 숫자 레이스: 규칙과 컴퓨터. 화면 없이 Node 에서 시험한다 (브라우저에서는 전역 LOGIC_NUMRACE).
// 5x5 판에 1~25 가 섞여 있고, 1부터 순서대로 25 까지 누른다. 온라인은 둘이 같은 판에서 먼저 끝내는 쪽이 이기고,
// 혼자 하기는 단계마다 제한 시간 안에 끝내면 남은 시간만큼 점수를 얻는다 (콤보 보너스).
const LOGIC_NUMRACE = (() => {
  const SIZE = 25;
  const WRONG_LOCK_MS = 600;       // 틀린 칸을 누르면 잠깐 멈춘다
  const RACE_MS = 90000;           // 이 시간이 지나면 더 멀리 간 사람이 이긴다
  const COUNT_MS = 3000;           // 시작 전 3-2-1
  const STAGE_SEC = [60, 55, 50, 46, 42, 38, 35, 32, 29, 26];   // 혼자 하기: 단계별 제한 시간(초). 마지막 단계를 넘기면 전 단계 클리어
  const TAP_POINTS = 10, COMBO_STEP = 5, COMBO_MAX = 5;          // 숫자 하나 10점, 콤보 5개마다 배수가 1씩 올라 최대 x5

  // 1~25 를 무작위로 섞은 판: 칸 번호(0~24) -> 숫자
  function shuffleBoard(rng = Math.random) {
    const b = Array.from({ length: SIZE }, (_, i) => i + 1);
    for (let i = SIZE - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  }

  // next[side] = 그 사람이 지금 눌러야 할 숫자 (26 이면 끝까지 감)
  function newRace(rng = Math.random) {
    return { board: shuffleBoard(rng), next: [1, 1], lockUntil: [0, 0], wrong: [0, 0], over: false, winner: -1, reason: '', finishedAt: [0, 0] };
  }

  // who 가 cell 을 눌렀다. now = 지금 시각(ms). 돌려주는 값 { kind }:
  //  'ignored' (끝났거나 잠겨 있거나 칸이 잘못됨), 'done' (이미 지나간 숫자: 아무 일 없음), 'wrong', 'ok', 'finish'
  function tap(g, who, cell, now) {
    if (g.over || (who !== 0 && who !== 1) || !Number.isInteger(cell) || cell < 0 || cell >= SIZE) return { kind: 'ignored' };
    if (now < g.lockUntil[who]) return { kind: 'ignored' };
    const n = g.board[cell];
    if (n < g.next[who]) return { kind: 'done', number: n };          // 이미 누른 숫자를 또 눌러도 벌은 없다
    if (n > g.next[who]) {
      g.wrong[who]++;
      g.lockUntil[who] = now + WRONG_LOCK_MS;
      return { kind: 'wrong', number: n, lockUntil: g.lockUntil[who] };
    }
    g.next[who]++;
    if (g.next[who] > SIZE) {
      g.over = true; g.winner = who; g.reason = 'finish'; g.finishedAt[who] = now;
      return { kind: 'finish', number: n };
    }
    return { kind: 'ok', number: n };
  }

  // 시간이 다 됐다: 더 멀리 간 사람이 이기고 같으면 무승부(2)
  function timeUp(g) {
    if (g.over) return;
    g.over = true; g.reason = 'timeout';
    g.winner = g.next[0] === g.next[1] ? 2 : (g.next[0] > g.next[1] ? 0 : 1);
  }

  // ---------- 혼자 하기 ----------
  const stageMs = (stage) => STAGE_SEC[Math.min(Math.max(1, stage), STAGE_SEC.length) - 1] * 1000;
  const comboMult = (combo) => Math.min(COMBO_MAX, 1 + Math.floor(combo / COMBO_STEP));   // combo = 지금까지 이어서 맞힌 수
  const clearBonus = (remainMs) => Math.max(0, Math.floor(remainMs / 10));                 // 남은 1초 = 100점

  // 한 단계 판. combo·score 는 단계를 넘어서 이어 가려면 이전 값을 넘겨 준다
  function newSolo(stage = 1, rng = Math.random, carry = {}) {
    return { stage, board: shuffleBoard(rng), next: 1, lockUntil: 0, wrong: 0, combo: carry.combo || 0, maxCombo: carry.maxCombo || 0, score: carry.score || 0, over: false, cleared: false };
  }
  // 혼자 하기에서 cell 을 눌렀다: { kind: 'ignored'|'done'|'wrong'|'ok'|'clear', points }
  function soloTap(s, cell, now) {
    if (s.over || !Number.isInteger(cell) || cell < 0 || cell >= SIZE) return { kind: 'ignored' };
    if (now < s.lockUntil) return { kind: 'ignored' };
    const n = s.board[cell];
    if (n < s.next) return { kind: 'done', number: n };
    if (n > s.next) { s.wrong++; s.combo = 0; s.lockUntil = now + WRONG_LOCK_MS; return { kind: 'wrong', number: n, lockUntil: s.lockUntil }; }
    s.combo++; s.maxCombo = Math.max(s.maxCombo, s.combo);
    const points = TAP_POINTS * comboMult(s.combo - 1);                  // 이번 숫자를 맞히기 직전의 콤보로 배수를 정한다
    s.score += points; s.next++;
    if (s.next > SIZE) { s.over = true; s.cleared = true; return { kind: 'clear', number: n, points }; }
    return { kind: 'ok', number: n, points };
  }
  // 단계를 깼다: 남은 시간 보너스를 더한다
  function soloClear(s, remainMs) { const bonus = clearBonus(remainMs); s.score += bonus; return bonus; }

  return { SIZE, WRONG_LOCK_MS, RACE_MS, COUNT_MS, STAGE_SEC, TAP_POINTS, COMBO_STEP, COMBO_MAX, shuffleBoard, newRace, tap, timeUp, stageMs, comboMult, clearBonus, newSolo, soloTap, soloClear };
})();
if (typeof module !== 'undefined') module.exports = LOGIC_NUMRACE;
