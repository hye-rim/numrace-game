'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (arcade/public/tutorial.js 가 듣는다. 튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 숫자 레이스: 화면·입력·소리·온라인. 규칙과 컴퓨터는 logic.js (LOGIC_NUMRACE), 방·매칭·판정은 server.js
(() => {
const L = LOGIC_NUMRACE;
const $ = (id) => document.getElementById(id);
const TUTORIAL = new URLSearchParams(location.search).has('tutorial');
const T = { step: 1000, over: 900, banner: 1000 };                  // 시간(ms). 시험용으로 줄일 수 있다
const RACE_MS = TUTORIAL ? 600000 : L.RACE_MS;                      // 튜토리얼은 시간이 다 되어 끝나지 않게
const BOT_SLOW = TUTORIAL ? 12 : 1;                                 // 튜토리얼에서는 컴퓨터가 아주 느리게 (사람이 설명을 읽는 동안 이기지 않게)

// ---------- 저장소 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
let wins = Number(store.get('numraceWins')) || 0;
let bestMs = Number(store.get('numraceBestMs')) || 0;
const ONLINE_KEY = 'numraceOnline', SESSION_KEY = 'numraceSession';
const loadJson = (k) => { try { return JSON.parse(store.get(k)) || {}; } catch (_) { return {}; } };
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; } }
function saveSession(s) { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const myName = () => store.get('numraceName') || '';
const fmt = (ms) => `${(ms / 1000).toFixed(2)}초`;

// ---------- 소리 ----------
let audio = null;
let muted = store.get('numraceMuted') === '1';
function tone(freq, dur, type = 'sine', vol = 0.09, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  } catch (_) {}
}
const seq = (notes, step, type = 'triangle', vol = 0.09) => notes.forEach((f, i) => setTimeout(() => tone(f, step * 0.0009, type, vol), i * step));
const sfx = {
  tap: (n) => tone(420 + n * 14, 0.05, 'triangle', 0.07),          // 숫자가 커질수록 높은 소리
  bad: () => tone(140, 0.22, 'sawtooth', 0.06, -50),
  beep: () => tone(660, 0.1, 'square', 0.06),
  go: () => tone(990, 0.22, 'square', 0.07),
  win: () => seq([523, 659, 784, 1047], 110, 'triangle', 0.1),
  lose: () => seq([392, 330, 262, 196], 150, 'sawtooth', 0.06),
  draw: () => seq([440, 440], 130, 'triangle', 0.07),
};
function toggleMute() { muted = !muted; store.set('numraceMuted', muted ? '1' : '0'); $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').onclick = (e) => { e.currentTarget.blur(); toggleMute(); };
$('muteBtn').textContent = muted ? '🔇' : '🔊';

// ---------- 상태 ----------
let mode = 'easy';                  // 'easy' · 'hard' (컴퓨터) · 'online'
let phase = 'title';                // title · play · over
let st = null;                      // 컴퓨터 대전 판 (나는 0번)
let cpuState = 'countdown';         // countdown · playing · over
let startedAt = 0, finishedMs = 0, deadline = 0;
let room = null, waitingNet = false, netDown = false, recorded = '';
let countTimers = [], botTimer = 0, raceTimer = 0, overTimer = 0, bannerTimer = 0, tickTimer = 0;
let lockEnd = 0, countEnd = 0, raceEnd = 0;                         // performance.now() 기준 시각
let badCell = -1, lastSent = -1;
const online = () => mode === 'online';

// 화면이 쓰는 모양으로: { board|null, next:[a,b], you, state, winner, reason, names }
function model() {
  if (online()) {
    if (!room) return null;
    return { board: room.board, next: room.next, wrong: room.wrong, you: room.you, state: room.state, winner: room.winner, reason: room.reason,
      names: [0, 1].map((c) => (c === room.you ? '나' : ((room.players.find((p) => p.color === c) || {}).name || '상대'))) };
  }
  if (!st) return null;
  return { board: cpuState === 'countdown' ? null : st.board, next: st.next, wrong: st.wrong, you: 0, state: cpuState, winner: st.winner, reason: st.reason, names: ['나', '컴퓨터'] };
}
const lockLeft = () => Math.max(0, lockEnd - performance.now());

// ---------- 그리기 ----------
const grid = $('grid');
grid.classList.add('s0');
for (let i = 0; i < L.SIZE; i++) {
  const b = document.createElement('button');
  b.className = 'cellb hide'; b.dataset.i = i; b.type = 'button'; b.textContent = '';
  grid.appendChild(b);
}
const cells = [...grid.children];

function render() {
  const m = model();
  if (!m) { renderHud(null); return; }
  const mine = m.next[m.you], theirs = m.next[1 - m.you];
  cells.forEach((el, i) => {
    const n = m.board ? m.board[i] : 0;
    el.textContent = n || '';
    el.classList.toggle('hide', !m.board);
    el.classList.toggle('done', !!m.board && n < mine);
    el.classList.toggle('bad', i === badCell);
  });
  grid.classList.toggle('locked', lockLeft() > 0 && m.state === 'playing');
  const lane = (id, name, side, next) => {
    const done = Math.min(L.SIZE, next - 1);
    $(id).innerHTML = `<span class="nm">${esc(name)}</span><div class="bar"><div class="fill" style="width:${(done / L.SIZE) * 100}%"></div></div><span class="cnt">${done}/${L.SIZE}</span>`;
  };
  lane('laneTop', m.names[1 - m.you], 1, theirs);
  lane('laneBottom', m.names[m.you], 0, mine);
  $('target').innerHTML = m.state === 'playing' && mine <= L.SIZE ? `다음 숫자 <b>${mine}</b>` : (m.state === 'countdown' ? '곧 시작해요! 1부터 순서대로 눌러요' : '');
  renderHud(m);
}
function renderHud(m = model()) {
  $('wins').textContent = wins.toLocaleString('ko-KR');
  let text = '숫자 레이스';
  if (m && phase === 'play') {
    if (online() && netDown) text = '연결 다시 붙이는 중…';
    else if (m.state === 'countdown') text = '준비…';
    else if (m.state === 'playing') text = `남은 시간 ${Math.max(0, Math.ceil(((online() ? raceEnd : deadline) - performance.now()) / 1000))}초`;
  }
  $('turn').textContent = text;
  $('resignBtn').style.display = online() && room && (room.state === 'playing' || room.state === 'countdown') ? '' : 'none';
}
function say(t) { $('msg').textContent = t; }
function banner(text, color) {
  const b = $('banner');
  b.textContent = text; b.style.color = color || '#fff'; b.classList.add('show');
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.remove('show'), T.banner);
}
function showCount(text) { const c = $('count'); c.textContent = text; c.classList.add('show'); }
function hideCount() { $('count').classList.remove('show'); }
function flashBad(i) {
  badCell = i; sfx.bad(); render();
  setTimeout(() => { if (badCell === i) { badCell = -1; render(); } }, 380);
}

// ---------- 창 ----------
const overlayOpen = () => !$('overlay').classList.contains('hidden');
function showOverlay(html) { $('overlay').innerHTML = html; $('overlay').classList.remove('hidden'); }
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ---------- 입력 ----------
grid.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.cellb');
  if (!el) return;
  e.preventDefault();
  const m = model();
  if (!m || phase !== 'play' || m.state !== 'playing' || netDown) return;
  const i = Number(el.dataset.i);
  if (lockLeft() > 0) return;
  if (online()) { lastSent = i; net.send('tap', { cell: i }); return; }
  const r = L.tap(st, 0, i, Date.now());
  if (r.kind === 'ok' || r.kind === 'finish') {
    sfx.tap(r.number); tutorialSignal('tap');
    if (r.kind === 'finish') { finishedMs = Date.now() - startedAt; endCpu(); return; }
    render();
  } else if (r.kind === 'wrong') {
    lockEnd = performance.now() + L.WRONG_LOCK_MS;
    tutorialSignal('wrong');
    flashBad(i);
    setTimeout(render, L.WRONG_LOCK_MS + 20);
  }
});
addEventListener('keydown', (e) => { if (e.code === 'KeyM') toggleMute(); });

// ---------- 컴퓨터 대전 ----------
function clearTimers() {
  countTimers.forEach(clearTimeout); countTimers = [];
  clearTimeout(botTimer); clearTimeout(raceTimer); clearTimeout(overTimer); clearTimeout(tickTimer);
}
function startCpu(level) {
  leaveOnline();
  clearTimers();
  mode = level; st = L.newRace(); phase = 'play'; cpuState = 'countdown'; lockEnd = 0; badCell = -1; finishedMs = 0;
  hideOverlay(); render(); say('');
  const steps = ['3', '2', '1'];
  steps.forEach((txt, k) => countTimers.push(setTimeout(() => { showCount(txt); sfx.beep(); }, k * T.step)));
  countTimers.push(setTimeout(beginCpu, steps.length * T.step));
}
function beginCpu() {
  showCount('GO!'); sfx.go();
  setTimeout(hideCount, 450);
  cpuState = 'playing'; startedAt = Date.now(); deadline = performance.now() + RACE_MS;
  raceTimer = setTimeout(() => { if (cpuState === 'playing') { L.timeUp(st); endCpu(); } }, RACE_MS);
  render(); say('1부터 순서대로 눌러요! 틀리면 잠깐 멈춰요');
  scheduleBot();
}
function scheduleBot() { botTimer = setTimeout(botTap, L.botDelay(mode === 'hard' ? 'hard' : 'easy') * BOT_SLOW); }
function botTap() {
  if (cpuState !== 'playing' || !st || st.over) return;
  const r = L.tap(st, 1, st.board.indexOf(st.next[1]), Date.now());
  if (r.kind === 'finish') { endCpu(); return; }
  render();
  scheduleBot();
}
function endCpu() {
  cpuState = 'over';
  clearTimeout(botTimer); clearTimeout(raceTimer);
  render();
  overTimer = setTimeout(showOver, T.over);
}
const reasonText = { finish: '', timeout: '시간이 다 되어 더 멀리 간 쪽이 이겼어요' };
function showOver() {
  phase = 'over';
  const youWon = st.winner === 0, draw = st.winner === 2;
  let newBest = false;
  if (youWon) {
    wins++; store.set('numraceWins', String(wins)); sfx.win();
    if (st.reason === 'finish' && finishedMs && (!bestMs || finishedMs < bestMs) && !TUTORIAL) { bestMs = finishedMs; store.set('numraceBestMs', String(bestMs)); newBest = true; }
  } else if (draw) sfx.draw(); else sfx.lose();
  showOverlay(`
    <h2>${draw ? '비겼어요! 🤝' : youWon ? '이겼어요! 🎉' : '아쉬워요! 😵'}</h2>
    <p>${esc(youWon && st.reason === 'finish' ? '25까지 먼저 눌렀어요' : (st.reason === 'timeout' ? reasonText.timeout : '컴퓨터가 먼저 25까지 눌렀어요'))}</p>
    <dl class="stats card2"><dt>나의 진행</dt><dd>${Math.min(25, st.next[0] - 1)} / 25</dd><dt>컴퓨터</dt><dd>${Math.min(25, st.next[1] - 1)} / 25</dd><dt>틀린 횟수</dt><dd>${st.wrong[0]}번</dd>${youWon && st.reason === 'finish' ? `<dt>내 기록</dt><dd>${fmt(finishedMs)}${newBest ? ' 🏅 최고!' : ''}</dd>` : ''}${bestMs ? `<dt>최고 기록</dt><dd>${fmt(bestMs)}</dd>` : ''}</dl>
    <p>컴퓨터 상대 승리 <b>${wins}</b>번</p>
    <div class="col"><button data-act="again">다시 하기</button><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="home">처음으로</button></div>`);
  render();
}
function showTitle() {
  leaveOnline();
  clearTimers(); hideCount();
  mode = 'easy'; phase = 'title'; st = L.newRace(); cpuState = 'countdown'; lockEnd = 0; badCell = -1;
  say(''); render();
  const on = loadJson(ONLINE_KEY);
  showOverlay(`
    <h1>숫자 레이스</h1>
    <p>흩어진 <b>1~25</b>를 <b>1부터 순서대로</b> 먼저 누르면 이겨요!</p>
    <div class="card2" style="font-size:13px">같은 판을 보고 둘이 동시에 달려요<br>틀린 숫자를 누르면 <b>0.6초 멈춰요</b><br>90초 안에 못 끝내면 더 멀리 간 쪽이 이겨요${bestMs ? `<br>내 최고 기록 <b>${fmt(bestMs)}</b>` : ''}</div>
    <div class="col"><button data-act="cpu" data-lv="easy">🤖 컴퓨터랑 · 쉬움</button><button class="sub" data-act="cpu" data-lv="hard">🤖 컴퓨터랑 · 어려움</button><button class="sub" data-act="online">🌐 온라인 대전${on.w || on.l ? ` · ${on.w || 0}승 ${on.l || 0}패` : ''}</button></div>`);
}

// ---------- 온라인: 연결 ----------
const net = {
  ws: null, pulse: null, outbox: [], retry: 0,
  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${location.pathname}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw('hello', { name: myName() });
      const s = loadSession();
      if (s) this.raw('resume', s);
      for (const [t, p] of this.outbox.splice(0)) this.raw(t, p);
      clearInterval(this.pulse);
      this.pulse = setInterval(() => this.raw('pulse'), 10000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onNet(m); };
    ws.onclose = () => {
      clearInterval(this.pulse);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!online()) return;
      if (room || loadSession()) {
        netDown = true; render();
        setTimeout(() => { if (online()) this.connect(); }, Math.min(4000, 500 * 2 ** this.retry++));
      } else showOnline('서버와 연결이 끊겼어요. 다시 시도해 주세요.');
    };
  },
  send(t, p = {}) {
    if (this.ws && this.ws.readyState === 1) this.raw(t, p);
    else { this.outbox.push([t, p]); this.connect(); }
  },
  raw(t, p = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...p })); },
  close() {
    const ws = this.ws;
    this.ws = null; this.outbox = [];
    clearInterval(this.pulse);
    if (ws) ws.close();
  },
};

function onNet(m) {
  if (m.t === 'queued') showQueued();
  else if (m.t === 'room') applyRoom(m);
  else if (m.t === 'error') { room = null; saveSession(null); showOnline(m.msg); }
  else if (m.t === 'resumeFailed') {
    saveSession(null);
    if (room) { room = null; showOnline('경기가 끝나서 이어갈 수 없어요.'); }
    netDown = false; render();
  }
}

function leaveOnline() {
  if (!online()) return;
  net.send('leave'); net.close();
  clearInterval(tickTimer);
  saveSession(null);
  room = null; netDown = false; mode = 'easy'; phase = 'title'; hideCount();
}

// ---------- 온라인: 경기 ----------
function applyRoom(r) {
  const prev = room;
  const fresh = !prev || prev.code !== r.code;
  const newGame = fresh || prev.games !== r.games;
  room = r;
  netDown = false;
  saveSession({ code: r.code, token: r.token });
  const now = performance.now();
  lockEnd = now + r.lockRemain; countEnd = now + r.countRemain; raceEnd = now + r.remain;
  if (newGame) { badCell = -1; say(''); }
  if (r.state === 'waiting') { phase = 'title'; showWaiting(); render(); return; }
  phase = r.state === 'over' ? 'over' : 'play';
  if (r.state !== 'over' && !($('overlay').dataset.screen === 'confirm')) hideOverlay();
  if (r.state === 'countdown') { if (newGame) { say(`상대는 ${esc((r.players.find((p) => p.color !== r.you) || {}).name || '상대')} · 1부터 순서대로 눌러요`); } startCountTicker(); }
  if (r.state === 'playing') { hideCount(); if (!prev || prev.state !== 'playing') { sfx.go(); say('1부터 순서대로 눌러요! 틀리면 잠깐 멈춰요'); } }
  // 내 숫자가 올라갔나 · 틀렸나
  if (prev && !newGame && r.state !== 'waiting') {
    const me = r.you;
    if (r.next[me] > prev.next[me]) { sfx.tap(r.next[me] - 1); tutorialSignal('tap'); }
    if (r.wrong[me] > prev.wrong[me]) { tutorialSignal('wrong'); flashBad(lastSent); }
  }
  render();
  if (lockLeft() > 0) setTimeout(render, lockLeft() + 20);
  if (r.state === 'over') afterOver();
}
function startCountTicker() {
  clearInterval(tickTimer);
  const tick = () => {
    if (!room || room.state !== 'countdown') { clearInterval(tickTimer); hideCount(); return; }
    const left = countEnd - performance.now();
    const n = Math.max(1, Math.ceil(left / 1000));
    const txt = left <= 0 ? 'GO!' : String(n);
    if ($('count').textContent !== txt || !$('count').classList.contains('show')) { showCount(txt); if (txt !== 'GO!') sfx.beep(); }
  };
  tick(); tickTimer = setInterval(tick, 100);
}
function afterOver() {
  const r = room;
  const key = `${r.code}:${r.games}:${r.reason}:${r.winner}`;
  if (recorded !== key) {
    recorded = key;
    const rec = loadJson(ONLINE_KEY);
    if (r.winner === r.you) { rec.w = (rec.w || 0) + 1; sfx.win(); } else if (r.winner === 2) sfx.draw(); else { rec.l = (rec.l || 0) + 1; sfx.lose(); }
    store.set(ONLINE_KEY, JSON.stringify(rec));
    setTimeout(() => { if (room && room.state === 'over') showResult(); }, T.over);
  } else if (overlayOpen()) showResult();
}

function showResult() {
  const r = room;
  const won = r.winner === r.you, draw = r.winner === 2;
  const why = {
    finish: won ? '25까지 먼저 눌렀어요' : '상대가 먼저 25까지 눌렀어요',
    timeout: draw ? '시간이 다 됐고 같은 곳까지 갔어요' : (won ? '시간이 다 되어 내가 더 멀리 갔어요' : '시간이 다 되어 상대가 더 멀리 갔어요'),
    resign: won ? '상대가 기권했어요' : '기권했어요',
    left: won ? '상대가 나갔어요' : '연결이 끊겨 패배했어요',
  }[r.reason] || '';
  const rec = loadJson(ONLINE_KEY);
  const opp = r.players.find((p) => p.color !== r.you);
  const iVoted = r.rematch.includes(r.you), theyVoted = opp && r.rematch.includes(opp.color);
  let again;
  if (!opp) again = '<p>상대가 방을 나갔어요</p>';
  else if (iVoted) again = '<p>상대를 기다리는 중…</p>';
  else again = `${theyVoted ? '<p>상대가 한 판 더 하고 싶어해요!</p>' : ''}<button data-act="rematch">한 판 더</button>`;
  showOverlay(`
    <h2>${draw ? '🤝 무승부' : won ? '🎉 승리!' : '😵 패배'}</h2>
    ${why ? `<p>${esc(why)}</p>` : ''}
    <p>나 ${Math.min(25, r.next[r.you] - 1)}/25 · 상대 ${Math.min(25, r.next[1 - r.you] - 1)}/25 · 틀림 ${r.wrong[r.you]}번</p>
    <span class="tag">온라인 ${rec.w || 0}승 ${rec.l || 0}패</span>
    <div class="col">${again}
      <div class="row"><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="leave">나가기</button></div>
    </div>`);
}

function showOnline(error = '') {
  leaveOnline();
  clearTimers(); hideCount();
  mode = 'online'; phase = 'title'; room = null; st = L.newRace(); cpuState = 'countdown'; lockEnd = 0; badCell = -1;
  say(''); render();
  showOverlay(`
    <h2>🌐 온라인 대전</h2>
    <input id="nameInput" maxlength="10" placeholder="내 이름 (최대 10자)" value="${esc(myName())}" autocomplete="off">
    <div class="col">
      <button data-act="quick">⚡ 빠른 대전</button>
      <button class="sub" data-act="create">방 만들기</button>
      <div class="row join"><input id="codeInput" maxlength="4" placeholder="방 코드" autocomplete="off" autocapitalize="characters"><button class="sub" data-act="join">들어가기</button></div>
    </div>
    <span class="error">${esc(error)}</span>
    <button class="back" data-act="home">← 처음으로</button>
    <p style="font-size:12.5px">둘이 모이면 3-2-1 뒤에 시작해요 · 한 판 90초</p>`);
}
function showQueued() {
  showOverlay(`
    <h2>상대를 찾는 중…</h2>
    <div class="dots"><span></span><span></span><span></span></div>
    <p>누군가 빠른 대전을 누르면 바로 시작해요</p>
    <button class="sub" data-act="cancel">취소</button>`);
}
const inviteUrl = () => `${location.origin}${location.pathname}?room=${room.code}`;
function showWaiting() {
  showOverlay(`
    <h2>친구를 기다리는 중…</h2>
    <p>방 코드</p>
    <div class="code">${esc(room.code)}</div>
    <p>친구가 <b>온라인 대전 → 들어가기</b>에<br>이 코드를 넣으면 시작해요</p>
    <button data-act="copy">🔗 초대 링크 복사</button>
    <button class="sub" data-act="cancel">취소</button>`);
}
function saveName() {
  const input = $('nameInput');
  if (!input) return;
  const name = input.value.trim().slice(0, 10);
  store.set('numraceName', name);
  net.send('hello', { name });
}
function confirmResign() {
  showOverlay(`<h2>기권할까요?</h2><p>이번 판은 패배로 기록돼요</p>
    <div class="row"><button data-act="close">계속하기</button><button class="sub" data-act="resign">🏳 기권</button></div>`);
  $('overlay').dataset.screen = 'confirm';
}

let lastCpu = 'easy';
$('overlay').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  btn.blur();
  $('overlay').dataset.screen = '';
  const act = btn.dataset.act;
  if (act === 'cpu') { lastCpu = btn.dataset.lv; startCpu(lastCpu); }
  else if (act === 'again') startCpu(lastCpu);
  else if (act === 'home') showTitle();
  else if (act === 'online') showOnline();
  else if (act === 'quick') { saveName(); net.send('quick'); }
  else if (act === 'create') { saveName(); net.send('create'); }
  else if (act === 'join') {
    const code = ($('codeInput').value || '').trim().toUpperCase();
    if (code.length !== 4) { $('overlay').querySelector('.error').textContent = '방 코드 4자리를 넣어 주세요.'; return; }
    saveName();
    net.send('join', { code });
  } else if (act === 'cancel') { net.send('cancel'); showOnline(); }
  else if (act === 'copy') {
    const url = inviteUrl();
    const done = () => { btn.textContent = '✅ 복사했어요'; setTimeout(() => { btn.textContent = '🔗 초대 링크 복사'; }, 1500); };
    if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: '숫자 레이스 한 판 해요!', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('링크를 복사하세요', url));
    else prompt('링크를 복사하세요', url);
  } else if (act === 'rematch') { net.send('rematch'); }
  else if (act === 'view') hideOverlay();
  else if (act === 'leave') showOnline();
  else if (act === 'resign') { net.send('resign'); hideOverlay(); }
  else if (act === 'close') hideOverlay();
});
$('overlay').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'codeInput') $('overlay').querySelector('[data-act="join"]').click();
  if (e.target.id === 'nameInput') $('overlay').querySelector('[data-act="quick"]').click();
  e.stopPropagation();
});
$('resignBtn').onclick = (e) => { e.currentTarget.blur(); if (online() && room && (room.state === 'playing' || room.state === 'countdown')) confirmResign(); };
setInterval(() => { const m = model(); if (m && phase === 'play' && m.state === 'playing' && !netDown) renderHud(m); }, 250);

// ---------- 시작 ----------
const invite = new URLSearchParams(location.search).get('room');
if (invite) { try { window.history.replaceState(null, '', location.pathname); } catch (_) {} }
function joinInvite(code) { showOnline(); net.send('join', { code: code.toUpperCase() }); }
if (loadSession()) {
  mode = 'online';
  render();
  showOverlay('<h2>경기로 돌아가는 중…</h2>');
  net.connect();
  const until = setInterval(() => {
    if (room || !loadSession()) { clearInterval(until); if (!room) invite ? joinInvite(invite) : showOnline(); }
  }, 100);
} else if (invite) joinInvite(invite);
else showTitle();

/* @test-hooks:start */
window.__nr = { get st() { return st; }, get mode() { return mode; }, get phase() { return phase; }, get room() { return room; }, get cpuState() { return cpuState; }, T, startCpu, render, model, L };
/* @test-hooks:end */
})();
