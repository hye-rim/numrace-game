'use strict';

// 서버 시험: 보안·안정성 회귀 + 숫자 레이스 온라인 경기 흐름
// 실행: npm test  (Node 18 이상, 별도 설치 없이 node:test)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');
const L = require('../public/logic.js');

// 운영체제가 지금 비어 있는 포트를 골라 준다 (고정 포트·범위 난수는 다른 서버와 겹쳐 가끔 실패한다)
const freePort = () => Number(require('child_process').execFileSync(process.execPath, ['-e', "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"]));
const PORT = freePort();
const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), RACE_MS: '3000', COUNT_MS: '400' }, stdio: 'ignore' });
child.unref();
process.on('exit', () => child.kill());
const ready = (async () => {
  for (let i = 0; i < 80; i++) { try { await get('/'); return; } catch { await sleep(100); } }
  throw new Error('server did not start');
})();

const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const c = { ws, msgs: [], room: null, queued: false, errors: [], closed: null };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    c.msgs.push(m);
    if (m.t === 'room') c.room = m;
    if (m.t === 'queued') c.queued = true;
    if (m.t === 'error') c.errors.push(m.msg);
  });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  ws.on('open', () => resolve(c));
  setTimeout(() => reject(new Error('websocket connect failed')), 3000);
});
const send = (c, t, p = {}) => c.ws.send(JSON.stringify({ t, ...p }));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };

// 두 손님을 빠른 대전으로 맺어 준다 (3-2-1 이 끝나 playing 이 될 때까지 기다린다)
async function pair() {
  const a = await open(), b = await open();
  send(a, 'hello', { name: '가' }); send(b, 'hello', { name: '나' });
  send(a, 'quick'); await until(() => a.queued);
  send(b, 'quick');
  assert.ok(await until(() => a.room && b.room && a.room.state === 'countdown' && b.room.state === 'countdown'), 'both enter the countdown');
  return [a, b];
}
async function pairPlaying() {
  const [a, b] = await pair();
  assert.ok(await until(() => a.room.state === 'playing' && b.room.state === 'playing'), 'the race starts after the countdown');
  return [a, b];
}
const closeAll = (...cs) => cs.forEach((c) => c.ws.close());
const tap = (c, cell) => send(c, 'tap', { cell });
const cellOf = (c, n) => c.room.board.indexOf(n);
const fresh = (c) => c.room.next[c.room.you];

test('malformed URLs get 400 and the server stays up', async () => {
  await ready;
  assert.strictEqual(await get('/%'), 400);
  assert.strictEqual(await get('/%00'), 400);
  assert.strictEqual(await get('/'), 200);
  assert.strictEqual(await get('/logic.js'), 200);
});

test('dotfiles and paths outside the public dir are not served', async () => {
  await ready;
  assert.strictEqual(await get('/.git/config'), 403);
  assert.ok([403, 404].includes(await get('/../server.js')));
});

test('oversized websocket message closes the connection (1009)', async () => {
  await ready;
  const c = await open();
  c.ws.send('x'.repeat(2 * 1024 * 1024));
  await sleep(500);
  assert.strictEqual(c.closed, 1009);
  assert.strictEqual(await get('/'), 200);
});

test('the board is hidden during the countdown and the same for both after the start', async () => {
  await ready;
  const [a, b] = await pair();
  assert.notStrictEqual(a.room.you, b.room.you);
  assert.strictEqual(a.room.board, null, 'no peeking before GO');
  assert.strictEqual(b.room.board, null);
  assert.ok(a.room.countRemain > 0);
  tap(a, 0); tap(b, 0);                                            // 시작 전에 눌러도 아무 일 없다
  assert.ok(await until(() => a.room.state === 'playing' && b.room.state === 'playing'));
  assert.deepStrictEqual(a.room.board, b.room.board);
  assert.deepStrictEqual([...a.room.board].sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.deepStrictEqual(a.room.next, [1, 1]);
  closeAll(a, b);
});

test('a correct tap moves you forward and the other screen sees it', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  tap(a, cellOf(a, 1));
  assert.ok(await until(() => b.room.next[a.room.you] === 2 && a.room.next[a.room.you] === 2));
  assert.strictEqual(b.room.next[b.room.you], 1, 'the other side did not move');
  await sleep(60);                                                 // 사람은 이보다 빨리 못 누른다 (서버가 25ms 이내는 무시)
  tap(a, cellOf(a, 2));
  assert.ok(await until(() => b.room.next[a.room.you] === 3));
  closeAll(a, b);
});

test('a wrong number locks you and taps during the lock are ignored', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  tap(a, cellOf(a, 7));
  assert.ok(await until(() => a.room.wrong[a.room.you] === 1 && a.room.lockRemain > 0));
  await sleep(60);
  tap(a, cellOf(a, 1));                                            // 잠긴 동안 맞는 숫자를 눌러도 안 먹는다
  await sleep(150);
  assert.strictEqual(fresh(a), 1);
  await sleep(600);
  tap(a, cellOf(a, 1));
  assert.ok(await until(() => fresh(a) === 2), 'works again after the lock');
  assert.strictEqual(fresh(b), 1, 'the other player is untouched');
  closeAll(a, b);
});

test('garbage taps are ignored and the server survives', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  for (const cell of [-1, 25, 1.5, '3', null, undefined, NaN, [], {}, 1e9]) { send(a, 'tap', { cell }); await sleep(30); }
  send(a, 'tap'); send(a, 'tap', 5); send(a, 'tap', { cell: [1] });
  await sleep(300);
  assert.deepStrictEqual(a.room.next, [1, 1]);
  assert.deepStrictEqual(a.room.wrong, [0, 0]);
  assert.strictEqual(await get('/'), 200);
  closeAll(a, b);
});

test('the first to reach 25 wins and later taps do nothing', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  for (let n = 1; n <= 25; n++) { tap(a, cellOf(a, n)); await sleep(30); }
  assert.ok(await until(() => a.room.state === 'over' && b.room.state === 'over'));
  assert.strictEqual(a.room.winner, a.room.you);
  assert.strictEqual(b.room.winner, a.room.you);
  assert.strictEqual(a.room.reason, 'finish');
  tap(b, cellOf(b, 1));
  await sleep(150);
  assert.strictEqual(fresh(b), 1, 'the loser cannot move after the end');
  closeAll(a, b);
});

test('time running out gives the win to whoever got further, equal is a draw', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  tap(a, cellOf(a, 1));
  assert.ok(await until(() => a.room.state === 'over', 5000), 'the timer fires');
  assert.strictEqual(a.room.reason, 'timeout');
  assert.strictEqual(a.room.winner, a.room.you);
  closeAll(a, b);
  const [c, d] = await pairPlaying();
  assert.ok(await until(() => c.room.state === 'over', 5000));
  assert.strictEqual(c.room.winner, 2);
  closeAll(c, d);
});

test('resigning ends the race and a rematch reshuffles the board', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  const firstBoard = a.room.board.slice();
  send(a, 'resign');
  assert.ok(await until(() => b.room.state === 'over'));
  assert.strictEqual(b.room.reason, 'resign');
  assert.strictEqual(b.room.winner, b.room.you);
  send(a, 'rematch'); send(b, 'rematch');
  assert.ok(await until(() => a.room.state === 'countdown' && a.room.games === 2));
  assert.ok(await until(() => a.room.state === 'playing'));
  assert.deepStrictEqual(a.room.next, [1, 1]);
  assert.notDeepStrictEqual(a.room.board, firstBoard, 'a new shuffle');
  closeAll(a, b);
});

test('private rooms: create, join by code, and a third player is turned away', async () => {
  await ready;
  const a = await open(), b = await open(), c = await open();
  send(a, 'create');
  assert.ok(await until(() => a.room && a.room.code));
  assert.strictEqual(a.room.state, 'waiting');
  send(b, 'join', { code: a.room.code.toLowerCase() });
  assert.ok(await until(() => a.room.state !== 'waiting' && b.room && b.room.state !== 'waiting'));
  send(c, 'join', { code: a.room.code });
  assert.ok(await until(() => c.errors.length > 0));
  assert.match(c.errors[0], /이미 두 사람/);
  a.ws.close(); b.ws.close(); c.ws.close();
});

test('leaving during the race hands the win to the other player', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  send(a, 'leave');
  assert.ok(await until(() => b.room.state === 'over'));
  assert.strictEqual(b.room.reason, 'left');
  assert.strictEqual(b.room.winner, b.room.you);
  closeAll(a, b);
});

test('a dropped player can resume the same seat with the token', async () => {
  await ready;
  const [a, b] = await pairPlaying();
  const token = a.room.token, code = a.room.code, you = a.room.you;
  a.ws.close();
  assert.ok(await until(() => b.room.players.some((p) => !p.online)), 'the other side sees the drop');
  const a2 = await open();
  send(a2, 'resume', { code, token });
  assert.ok(await until(() => a2.room && a2.room.you === you && a2.room.state === 'playing'));
  assert.ok(await until(() => b.room.players.every((p) => p.online)));
  a2.ws.close(); b.ws.close();
});

// 같은 주소에서 코드를 일부러 많이 틀리므로 이 시험은 맨 뒤에 둔다 (뒤의 시험이 막히지 않게)
test('repeated wrong room codes get temporarily blocked', async () => {
  await ready;
  const c = await open();
  for (let i = 0; i < 10; i++) c.ws.send(JSON.stringify({ t: 'join', code: 'ZZZ' + 'ABCDEFGH'[i] }));
  await sleep(500);
  assert.ok(c.errors.some((x) => /그런 방이 없어요/.test(x)), 'first attempts are answered with room-not-found');
  assert.ok(c.errors.some((x) => /너무 많이 틀렸어요/.test(x)), 'many wrong codes get blocked');
  c.ws.close();
});

test('shutdown', () => { child.kill(); });
