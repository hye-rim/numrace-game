'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// 규칙은 브라우저와 같은 코드를 쓴다. 누르는 동작은 모두 서버가 같은 규칙으로 판정한다. 판의 숫자 배치는 시작 신호 뒤에야 보낸다 (미리 못 보게)
const L = require('./public/logic.js');
const rand = () => crypto.randomInt(1 << 30) / (1 << 30);

// ---------- Config ----------
const PORT = process.env.PORT || 3025;
const RACE_MS = Number(process.env.RACE_MS) || L.RACE_MS;     // 한 판 제한 시간. 넘기면 더 멀리 간 사람이 이긴다. 시험에서는 환경변수로 줄인다
const COUNT_MS = Number(process.env.COUNT_MS) || L.COUNT_MS;  // 시작 전 3-2-1
const MIN_TAP_GAP_MS = 25;      // 한 사람이 이보다 빠르게 보내는 누르기는 무시한다 (사람은 못 누르는 속도)
const GRACE_MS = 30000;         // 경기 중 연결이 끊겨도 이 시간 안에 돌아오면 이어서 한다
// 프록시가 WebSocket ping 을 대신 받아버리는 환경이 있어, 클라이언트가 보내는 pulse 로 살아있는지 본다
const HEARTBEAT_MS = 25000;
const SILENCE_TIMEOUT_MS = 90000;
// 헷갈리는 글자(0/O, 1/I)는 빼서 코드를 불러주기 쉽게 한다
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Static file server ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
// 주소 해석·파일 경로 검사: 잘못된 % 표기나 널 문자는 null, 점으로 시작하는 파일과 폴더 밖 경로는 내보내지 않는다
function safeDecode(s) {
  try {
    const d = decodeURIComponent(s);
    return d.includes('\0') ? null : d;
  } catch { return null; }
}
function isServable(filePath, baseDir) {
  const inside = filePath === baseDir || filePath.startsWith(baseDir + path.sep);
  return inside && !filePath.slice(baseDir.length).split(path.sep).some((seg) => seg.startsWith('.'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let reqPath = safeDecode(req.url.split('?')[0]);
  if (reqPath === null) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad request'); return; }
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!isServable(filePath, PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// 메시지 크기 제한: 기본값(100MB)이면 큰 메시지 하나로 서버 메모리를 먹일 수 있다. 이 게임의 메시지는 모두 이보다 훨씬 작다
const wss = new WebSocketServer({ server, maxPayload: 1024 });

// ---------- 방 코드 무차별 대입 방지 ----------
// 없는 방 코드를 짧은 시간에 여러 번 대면 잠깐 막는다 (손님 주소 기준: 로비 프록시가 붙여 주는 x-forwarded-for 의 첫 값)
const JOIN_FAIL_MAX = 8, JOIN_WINDOW_MS = 60000, JOIN_BLOCK_MS = 60000;
const joinFails = new Map();   // 주소 -> { n, since, until }
const clientIp = (req) => String((req && req.headers['x-forwarded-for']) || (req && req.socket.remoteAddress) || '').split(',')[0].trim();
function joinBlocked(ip) {
  const f = joinFails.get(ip);
  return !!f && f.until > Date.now();
}
function noteJoinFail(ip) {
  const now = Date.now();
  let f = joinFails.get(ip);
  if (!f || now - f.since > JOIN_WINDOW_MS) f = { n: 0, since: now, until: 0 };
  f.n++;
  if (f.n >= JOIN_FAIL_MAX) { f.until = now + JOIN_BLOCK_MS; f.n = 0; f.since = now; }
  joinFails.set(ip, f);
  if (joinFails.size > 2000) for (const [k, v] of joinFails) if (v.until < now && now - v.since > JOIN_WINDOW_MS) joinFails.delete(k);
}

// ---------- State ----------
const rooms = new Map();     // code -> room
const clients = new Map();   // ws -> client
let queue = null;            // 빠른 대전을 기다리는 client 하나
let nextId = 1;

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ t: type, ...payload }));
}

function makeCode() {
  for (let k = 0; k < 50; k++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

const makeToken = () => crypto.randomBytes(18).toString('base64url');   // 자리를 되찾는 열쇠: 예측할 수 없는 난수로

function sanitizeName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);
  return name || `손님${Math.floor(100 + Math.random() * 900)}`;
}


// ---------- Rooms ----------
function createRoom(isPrivate) {
  const room = {
    code: makeCode(),
    isPrivate,
    seats: [],               // { client, name, color, token, online, graceTimer, lastTap } — color 는 자리 번호 (0 · 1, 서로 똑같은 규칙)
    game: L.newRace(rand),
    state: 'waiting',        // waiting | countdown | playing | over
    winner: -1,              // 0 · 1 · 2 무승부
    reason: '',              // finish | timeout | resign | left
    startAt: 0,              // 'GO' 가 되는 시각 (ms)
    deadline: 0,             // 시간이 끝나는 시각 (ms)
    timer: null,
    rematch: new Set(),      // 한 판 더를 누른 색
    games: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function seatOf(room, client) {
  return room.seats.find((s) => s.client === client);
}

function snapshot(room, seat) {
  const g = room.game, now = Date.now();
  const showBoard = room.state === 'playing' || room.state === 'over';
  return {
    code: room.code,
    isPrivate: room.isPrivate,
    token: seat.token,
    you: seat.color,
    players: room.seats.map((s) => ({ name: s.name, color: s.color, online: s.online })),
    board: showBoard ? g.board.slice() : null,
    next: g.next.slice(),                       // 두 사람이 지금 눌러야 할 숫자 (서로 얼마나 갔는지 보이게)
    wrong: g.wrong.slice(),
    lockRemain: Math.max(0, g.lockUntil[seat.color] - now),
    games: room.games,
    state: room.state,
    winner: room.winner,
    reason: room.reason,
    countRemain: room.state === 'countdown' ? Math.max(0, room.startAt - now) : 0,
    remain: room.state === 'playing' ? Math.max(0, room.deadline - now) : 0,
    rematch: [...room.rematch],
  };
}

function pushRoom(room) {
  for (const s of room.seats) if (s.online) send(s.client.ws, 'room', snapshot(room, s));
}

function sitDown(room, client) {
  const seat = { client, name: client.name, color: room.seats.length, token: makeToken(), online: true, graceTimer: null, lastTap: 0 };
  room.seats.push(seat);
  client.roomCode = room.code;
  if (room.seats.length === 2) startGame(room);
  else pushRoom(room);
}

// 3-2-1 을 센 뒤 시작한다. 판은 매번 새로 섞는다
function startGame(room) {
  clearTimeout(room.timer);
  room.game = L.newRace(rand);
  room.state = 'countdown';
  room.winner = -1;
  room.reason = '';
  room.rematch.clear();
  room.games++;
  room.startAt = Date.now() + COUNT_MS;
  room.timer = setTimeout(() => beginRace(room), COUNT_MS);
  pushRoom(room);
}

function beginRace(room) {
  if (room.state !== 'countdown') return;
  room.state = 'playing';
  room.deadline = Date.now() + RACE_MS;
  room.timer = setTimeout(() => timeUp(room), RACE_MS);
  pushRoom(room);
}

function timeUp(room) {
  if (room.state !== 'playing') return;
  L.timeUp(room.game);
  endGame(room, room.game.winner, 'timeout');
}

function endGame(room, winner, reason) {
  if (room.state !== 'playing' && room.state !== 'countdown') return;
  clearTimeout(room.timer);
  room.state = 'over';
  room.winner = winner;
  room.reason = reason;
  room.game.over = true;
  pushRoom(room);
}

function closeRoom(room) {
  clearTimeout(room.timer);
  for (const s of room.seats) {
    clearTimeout(s.graceTimer);
    if (s.client) s.client.roomCode = null;
  }
  rooms.delete(room.code);
}

// 자리에서 완전히 일어난다 (나가기, 또는 끊긴 뒤 돌아오지 않음)
function vacate(room, seat) {
  clearTimeout(seat.graceTimer);
  if (room.state === 'playing' || room.state === 'countdown') endGame(room, 1 - seat.color, 'left');
  room.seats = room.seats.filter((s) => s !== seat);
  if (seat.client) seat.client.roomCode = null;
  if (!room.seats.length || room.state === 'waiting') { closeRoom(room); return; }
  // 남은 사람은 결과창에 머문다. 상대가 없으니 한 판 더는 할 수 없다.
  room.rematch.clear();
  pushRoom(room);
}

function dropFromQueue(client) {
  if (queue === client) queue = null;
}

// ---------- Handlers ----------
const handlers = {
  hello(client, msg) {
    client.name = sanitizeName(msg.name);
  },

  quick(client) {
    if (client.roomCode) return;
    if (queue && queue !== client && queue.ws.readyState === queue.ws.OPEN) {
      const other = queue;
      queue = null;
      const room = createRoom(false);
      sitDown(room, other);
      sitDown(room, client);
    } else {
      queue = client;
      send(client.ws, 'queued');
    }
  },

  create(client) {
    if (client.roomCode) return;
    dropFromQueue(client);
    sitDown(createRoom(true), client);
  },

  join(client, msg) {
    if (client.roomCode) return;
    dropFromQueue(client);
    if (joinBlocked(client.ip)) return send(client.ws, 'error', { msg: '방 코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.' });
    const room = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!room) { noteJoinFail(client.ip); return send(client.ws, 'error', { msg: '그런 방이 없어요. 코드를 확인해 주세요.' }); }
    if (room.seats.length >= 2) return send(client.ws, 'error', { msg: '이미 두 사람이 하고 있는 방이에요.' });
    sitDown(room, client);
  },

  // 새로고침·네트워크 끊김 뒤 같은 자리로 돌아온다
  resume(client, msg) {
    const room = rooms.get(String(msg.code || ''));
    const seat = room && room.seats.find((s) => s.token === msg.token);
    if (!seat) return send(client.ws, 'resumeFailed');
    if (seat.client && seat.client !== client && seat.client.ws.readyState === seat.client.ws.OPEN) {
      seat.client.roomCode = null;
      send(seat.client.ws, 'error', { msg: '다른 창에서 이 경기에 다시 들어왔어요.' });
    }
    clearTimeout(seat.graceTimer);
    seat.client = client;
    seat.online = true;
    client.name = seat.name;
    client.roomCode = room.code;
    pushRoom(room);
  },

  cancel(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && room.state === 'waiting') vacate(room, seat);
  },

  // 칸을 눌렀다: { cell }. 숫자가 맞는지는 서버가 판정한다 (클라이언트는 믿지 않는다)
  tap(client, msg) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'playing') return;
    const now = Date.now();
    if (now - seat.lastTap < MIN_TAP_GAP_MS) return;
    seat.lastTap = now;
    if (!Number.isInteger(msg.cell)) return;
    const r = L.tap(room.game, seat.color, msg.cell, now);
    if (r.kind === 'ok') pushRoom(room);                         // 앞서 가는 모습이 상대 화면에도 보인다
    else if (r.kind === 'wrong') send(client.ws, 'room', snapshot(room, seat));
    else if (r.kind === 'finish') endGame(room, seat.color, 'finish');
  },

  resign(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && (room.state === 'playing' || room.state === 'countdown')) endGame(room, 1 - seat.color, 'resign');
  },

  rematch(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'over' || room.seats.length < 2) return;
    room.rematch.add(seat.color);
    if (room.rematch.size === 2) startGame(room);
    else pushRoom(room);
  },

  leave(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat) vacate(room, seat);
  },

  pulse() {},
};

// ---------- Connections ----------
function onDisconnect(client) {
  dropFromQueue(client);
  const room = rooms.get(client.roomCode);
  const seat = room && seatOf(room, client);
  if (!seat) return;
  if (room.state !== 'playing' && room.state !== 'countdown') { vacate(room, seat); return; }
  // 경기 중이면 잠깐 기다려 준다
  seat.online = false;
  seat.client = null;
  seat.graceTimer = setTimeout(() => vacate(room, seat), GRACE_MS);
  pushRoom(room);
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, HEARTBEAT_MS);

const silenceSweep = setInterval(() => {
  const now = Date.now();
  for (const [ws, client] of clients) {
    if (now - client.lastSeen > SILENCE_TIMEOUT_MS) ws.terminate();
  }
}, 5000);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(silenceSweep); });

wss.on('connection', (ws, req) => {
  ws.on('error', () => {});   // 크기 제한 초과 같은 연결 오류는 그 손님의 연결만 끊고, 처리하지 않으면 서버 전체가 죽는다
  const client = { id: nextId++, ws, ip: clientIp(req), name: sanitizeName(''), roomCode: null, lastSeen: Date.now() };
  clients.set(ws, client);

  ws.on('message', (raw) => {
    client.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = handlers[msg && msg.t];
    if (handler) handler(client, msg);
  });

  ws.on('close', () => {
    onDisconnect(client);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`숫자 레이스 서버 실행 중 → http://localhost:${PORT}`);
});
