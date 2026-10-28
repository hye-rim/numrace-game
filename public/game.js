'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (arcade/public/tutorial.js 가 듣는다. 튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 숫자 레이스: 화면·입력·소리·온라인. 규칙은 logic.js (LOGIC_NUMRACE), 방·매칭·판정은 server.js
// 혼자 하기(기록 도전): 단계마다 제한 시간 안에 1~25 를 누르고, 남은 시간만큼 점수를 얻는다 (콤보 보너스). 온라인은 둘이 먼저 끝내기
(() => {
const L = LOGIC_NUMRACE;
const $ = (id) => document.getElementById(id);
const TUTORIAL = new URLSearchParams(location.search).has('tutorial');
const T = { step: 1000, over: 900, banner: 1000 };                  // 시간(ms). 시험용으로 줄일 수 있다
const stageTime = (stage) => (TUTORIAL ? 600000 : L.stageMs(stage));    // 튜토리얼은 시간이 다 되어 끝나지 않게

// ---------- 저장소 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
let best = Number(store.get('numraceBest')) || 0, bestStage = Number(store.get('numraceBestStage')) || 0;     // 혼자 하기 최고 점수·최고 단계
const ONLINE_KEY = 'numraceOnline', SESSION_KEY = 'numraceSession';
const loadJson = (k) => { try { return JSON.parse(store.get(k)) || {}; } catch (_) { return {}; } };
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; } }
function saveSession(s) { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const myName = () => store.get('numraceName') || '';
const num = (n) => n.toLocaleString('ko-KR');

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
  combo: (m) => seq([784, 988, 1175].slice(0, Math.min(3, m)), 55, 'triangle', 0.08),   // 배수가 오를 때
  clear: () => seq([523, 659, 784, 1047, 1319], 90, 'triangle', 0.1),
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
let mode = 'solo';                  // 'solo' (혼자 하기) · 'online'
let phase = 'title';                // title · play · over
let st = null;                      // 혼자 하기: 지금 단계의 판
let run = null;                     // 혼자 하기: 이번 도전 { wrong, stageClears } (점수·콤보는 st 에 이어진다)
let cpuState = 'countdown';         // 혼자 하기 단계 상태: countdown · playing · over
let deadline = 0;
let room = null, waitingNet = false, netDown = false, recorded = '';
let countTimers = [], raceTimer = 0, overTimer = 0, bannerTimer = 0, tickTimer = 0;
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
  return { solo: true, board: cpuState === 'countdown' ? null : st.board, next: [st.next, 1], wrong: [st.wrong, 0], you: 0, state: cpuState, winner: -1, reason: '', names: ['나', ''] };
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
  if (m.solo) {
    const mult = L.comboMult(st.combo);
    $('laneTop').innerHTML = `<span class="nm">${st.stage}단계</span><span class="sc">점수 <b>${num(st.score)}</b></span><span class="cb${st.combo >= L.COMBO_STEP ? ' hot' : ''}">🔥 ${st.combo}콤보${mult > 1 ? ` x${mult}` : ''}</span>`;
  } else lane('laneTop', m.names[1 - m.you], 1, theirs);
  lane('laneBottom', m.names[m.you], 0, mine);
  $('target').innerHTML = m.state === 'playing' && mine <= L.SIZE ? `다음 숫자 <b>${mine}</b>` : (m.state === 'countdown' ? '곧 시작해요! 1부터 순서대로 눌러요' : '');
  renderHud(m);
}
function renderHud(m = model()) {
  $('wins').textContent = num(best);
  let text = '숫자 레이스';
  if (m && phase === 'play') {
    if (online() && netDown) text = '연결 다시 붙이는 중…';
    else if (m.state === 'countdown') text = '준비…';
    else if (m.state === 'playing') text = `${m.solo ? `${st.stage}단계 · ` : ''}남은 시간 ${Math.max(0, Math.ceil(((online() ? raceEnd : deadline) - performance.now()) / 1000))}초`;
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
  const prevMult = L.comboMult(st.combo);
  const r = L.soloTap(st, i, Date.now());
  if (r.kind === 'ok' || r.kind === 'clear') {
    sfx.tap(r.number); tutorialSignal('tap');
    const mult = L.comboMult(st.combo);
    if (mult > prevMult) { sfx.combo(mult); banner(`콤보 x${mult}!`, '#ffd23f'); }
    if (r.kind === 'clear') { stageClear(); return; }
    render();
  } else if (r.kind === 'wrong') {
    lockEnd = performance.now() + L.WRONG_LOCK_MS;
    tutorialSignal('wrong');
    flashBad(i);
    setTimeout(render, L.WRONG_LOCK_MS + 20);
  }
});
addEventListener('keydown', (e) => { if (e.code === 'KeyM') toggleMute(); });

// ---------- 혼자 하기 ----------
function clearTimers() {
  countTimers.forEach(clearTimeout); countTimers = [];
  clearTimeout(raceTimer); clearTimeout(overTimer); clearTimeout(tickTimer);
}
function startSolo() {
  leaveOnline();
  clearTimers();
  mode = 'solo'; run = { wrong: 0 }; hideOverlay();
  prepStage(L.newSolo(1), true);
}
// 단계 시작 전: 첫 단계는 3-2-1, 다음 단계부터는 "N단계" 를 잠깐 보여 준다 (그동안 판은 가려져 있다)
function prepStage(next, first) {
  clearTimers();
  st = next; phase = 'play'; cpuState = 'countdown'; lockEnd = 0; badCell = -1;
  render(); say(first ? '' : `${st.stage}단계! 제한 시간 ${stageTime(st.stage) / 1000}초`);
  const steps = first ? ['3', '2', '1'] : [`${st.stage}단계`];
  steps.forEach((txt, k) => countTimers.push(setTimeout(() => { showCount(txt); sfx.beep(); }, k * T.step)));
  countTimers.push(setTimeout(beginStage, steps.length * T.step));
}
function beginStage() {
  showCount('GO!'); sfx.go();
  setTimeout(hideCount, 450);
  cpuState = 'playing'; deadline = performance.now() + stageTime(st.stage);
  raceTimer = setTimeout(() => { if (cpuState === 'playing') timeUpSolo(); }, stageTime(st.stage));
  render(); say('1부터 순서대로 눌러요! 틀리면 멈추고 콤보가 끊겨요');
}
function stageClear() {
  clearTimeout(raceTimer);
  cpuState = 'over';
  const remain = Math.max(0, deadline - performance.now());
  const bonus = L.soloClear(st, remain);
  run.wrong += st.wrong;
  sfx.clear();
  banner(`클리어! +${num(bonus)}`, '#b9ffc8');
  say(`${st.stage}단계 클리어! 남은 ${(remain / 1000).toFixed(1)}초 → +${num(bonus)}점`);
  render();
  tutorialSignal('stage');
  const last = st.stage >= L.STAGE_SEC.length;
  overTimer = setTimeout(() => (last ? finishSolo(true) : prepStage(L.newSolo(st.stage + 1, Math.random, st), false)), T.over + 900);
}
function timeUpSolo() {
  clearTimeout(raceTimer);
  cpuState = 'over';
  run.wrong += st.wrong;
  render();
  overTimer = setTimeout(() => finishSolo(false), T.over);
}
function finishSolo(all) {
  phase = 'over';
  const reached = all ? L.STAGE_SEC.length : st.stage;
  const cleared = all ? reached : reached - 1;                           // 깬 단계 수
  let newBest = false;
  if (!TUTORIAL && st.score > best) { best = st.score; newBest = true; store.set('numraceBest', String(best)); }
  if (!TUTORIAL && cleared > bestStage) { bestStage = cleared; store.set('numraceBestStage', String(bestStage)); }
  all ? sfx.win() : (cleared > 0 ? sfx.draw() : sfx.lose());
  showOverlay(`
    <h2>${all ? '전 단계 클리어! 🎉' : '시간 끝! ⏰'}</h2>
    <p>${all ? `${L.STAGE_SEC.length}단계를 모두 깼어요!` : `${reached}단계에서 ${cleared > 0 ? `${cleared}단계까지 깼어요` : '시간이 모자랐어요'}`}</p>
    <dl class="stats card2"><dt>점수</dt><dd>${num(st.score)}점${newBest ? ' 🏅 최고!' : ''}</dd><dt>깬 단계</dt><dd>${cleared} / ${L.STAGE_SEC.length}</dd><dt>최고 콤보</dt><dd>${st.maxCombo}</dd><dt>틀린 횟수</dt><dd>${run.wrong}번</dd><dt>최고 점수</dt><dd>${num(best)}점</dd></dl>
    <div class="col"><button data-act="again">다시 도전</button><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="home">처음으로</button></div>`);
  render();
}
function showTitle() {
  leaveOnline();
  clearTimers(); hideCount();
  mode = 'solo'; phase = 'title'; st = L.newSolo(); run = null; cpuState = 'countdown'; lockEnd = 0; badCell = -1;
  say(''); render();
  const on = loadJson(ONLINE_KEY);
  showOverlay(`
    <h1>숫자 레이스</h1>
    <p>흩어진 <b>1~25</b>를 <b>1부터 순서대로</b> 빨리 눌러요!</p>
    <div class="card2" style="font-size:13px"><b>혼자 하기</b>: 단계마다 제한 시간이 있어요 (60초 → 26초, 10단계)<br>빨리 끝낼수록 <b>남은 시간만큼 점수</b>를 얻어요 (1초 = 100점)<br>안 틀리고 이어서 맞히면 <b>콤보</b>! 5개마다 점수가 x2, x3 … 최대 x5<br>틀리면 <b>0.6초 멈추고 콤보가 끊겨요</b>${best ? `<br>내 최고 점수 <b>${num(best)}점</b> · ${bestStage}단계` : ''}</div>
    <div class="col"><button data-act="solo">🏃 혼자 하기 · 기록 도전</button><button class="sub" data-act="online">🌐 온라인 대전${on.w || on.l ? ` · ${on.w || 0}승 ${on.l || 0}패` : ''}</button></div>`);
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
  room = null; netDown = false; mode = 'solo'; phase = 'title'; hideCount();
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

$('overlay').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  btn.blur();
  $('overlay').dataset.screen = '';
  const act = btn.dataset.act;
  if (act === 'solo' || act === 'again') startSolo();
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
window.__nr = { get st() { return st; }, get run() { return run; }, get mode() { return mode; }, get phase() { return phase; }, get room() { return room; }, get cpuState() { return cpuState; }, T, startSolo, render, model, L };
/* @test-hooks:end */
})();
