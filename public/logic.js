'use strict';
// 숫자 레이스: 규칙과 컴퓨터. 화면 없이 Node 에서 시험한다 (브라우저에서는 전역 LOGIC_NUMRACE).
// 5x5 판에 1~25 가 섞여 있고, 두 사람이 같은 판을 보며 1부터 순서대로 먼저 25 까지 누르면 이긴다.
const LOGIC_NUMRACE = (() => {
  const SIZE = 25;
  const WRONG_LOCK_MS = 600;       // 틀린 칸을 누르면 잠깐 멈춘다
  const RACE_MS = 90000;           // 이 시간이 지나면 더 멀리 간 사람이 이긴다
  const COUNT_MS = 3000;           // 시작 전 3-2-1
  const BOT = { easy: [1800, 500], hard: [1100, 300] };   // 컴퓨터가 숫자 하나 찾는 데 걸리는 시간 [평균, 흔들림] (ms)

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

  // 컴퓨터가 다음 숫자를 누르기까지 기다리는 시간 (ms)
  function botDelay(level, rng = Math.random) {
    const [mean, spread] = BOT[level] || BOT.easy;
    return Math.max(250, mean + (rng() * 2 - 1) * spread);
  }

  return { SIZE, WRONG_LOCK_MS, RACE_MS, COUNT_MS, BOT, shuffleBoard, newRace, tap, timeUp, botDelay };
})();
if (typeof module !== 'undefined') module.exports = LOGIC_NUMRACE;
