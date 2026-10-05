const test = require('node:test');
const assert = require('node:assert/strict');
const { io: Client } = require('socket.io-client');
const { createAppServer } = require('../server');

function emit(socket, event, data = {}) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}
function nextState(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('state', handler); reject(new Error('state timeout')); }, 2500);
    function handler(state) { if (predicate(state)) { clearTimeout(timer); socket.off('state', handler); resolve(state); } }
    socket.on('state', handler);
  });
}

test('キーやコードなしで同じ待機室に参加・開始でき、相手の手札は配信されない', async (t) => {
  const { server, io } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => io.close(() => server.close(resolve))));
  const url = `http://127.0.0.1:${server.address().port}`;
  const host = Client(url, { transports: ['websocket'] });
  const guest = Client(url, { transports: ['websocket'] });
  t.after(() => { host.close(); guest.close(); });
  await Promise.all([new Promise((r) => host.on('connect', r)), new Promise((r) => guest.on('connect', r))]);

  const created = await emit(host, 'joinRoom', { name: 'ホスト', color: '#2a9d8f', targetScore: 3 });
  assert.equal(created.ok, true);
  assert.equal(Object.hasOwn(created, 'roomCode'), false);
  const hostJoined = nextState(host, (s) => s.players.length === 2);
  const joined = await emit(guest, 'joinRoom', { name: 'ゲスト' });
  assert.equal(joined.ok, true);
  await hostJoined;

  const hostStarted = nextState(host, (s) => s.phase === 'turn');
  const guestStarted = nextState(guest, (s) => s.phase === 'turn');
  assert.equal((await emit(host, 'startMatch')).ok, true);
  const [hostState, guestState] = await Promise.all([hostStarted, guestStarted]);
  assert.equal(hostState.players.length, 2);
  assert.equal(Object.hasOwn(hostState, 'code'), false);
  assert.equal(hostState.players.find((p) => p.name === 'ホスト').color, '#2a9d8f');
  assert.equal(guestState.players.length, 2);
  assert.equal(hostState.players.some((p) => Object.hasOwn(p, 'hand')), false);
  assert.equal(guestState.players.some((p) => Object.hasOwn(p, 'hand')), false);
  assert.ok(hostState.hand.length >= 1 && hostState.hand.length <= 2);
  assert.ok(guestState.hand.length >= 1 && guestState.hand.length <= 2);
});

test('参加制限、トークンだけでの再接続、退出後の再参加を維持する', async (t) => {
  const { server, io } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => io.close(() => server.close(resolve))));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(() => sockets.forEach((socket) => socket.close()));
  async function connect() {
    const socket = Client(url, { transports: ['websocket'] });
    sockets.push(socket);
    await new Promise((resolve) => socket.on('connect', resolve));
    return socket;
  }
  const host = await connect();
  assert.equal((await emit(host, 'joinRoom', { name: ' ' })).ok, false);
  const joinedState = nextState(host);
  const joined = await emit(host, 'joinRoom', { name: 'ホスト' });
  assert.equal(joined.ok, true);
  const original = await joinedState;
  assert.equal(original.isHost, true);
  assert.equal((await emit(host, 'joinRoom', { name: '重複参加' })).ok, false);
  const guest = await connect();
  assert.equal((await emit(guest, 'joinRoom', { name: 'ホスト' })).ok, false);
  assert.equal((await emit(guest, 'joinRoom', { name: 'ゲスト' })).ok, true);
  for (let i = 3; i <= 5; i++) {
    assert.equal((await emit(await connect(), 'joinRoom', { name: `参加者${i}` })).ok, true);
  }
  const extra = await connect();
  const full = await emit(extra, 'joinRoom', { name: '満員時' });
  assert.equal(full.ok, false);
  assert.match(full.error, /満員/);
  const disconnected = nextState(guest, (state) => state.players.some((p) => p.name === 'ホスト' && !p.connected));
  host.close();
  await disconnected;
  const restored = await connect();
  const restoredState = nextState(restored);
  assert.equal((await emit(restored, 'reconnectRoom', { sessionId: joined.sessionId })).ok, true);
  const afterReconnect = await restoredState;
  assert.equal(afterReconnect.viewerId, original.viewerId);
  assert.equal(afterReconnect.isHost, true);
  assert.equal((await emit(restored, 'leaveRoom')).ok, true);
  assert.equal((await emit(restored, 'joinRoom', { name: '再参加' })).ok, true);
  assert.equal((await emit(guest, 'startMatch')).ok, true);
  const started = await emit(extra, 'joinRoom', { name: '途中参加' });
  assert.equal(started.ok, false);
  assert.match(started.error, /対戦開始後/);
});

test('全員退出後は新しい待機室になり、古いトークンは使えない', async (t) => {
  const { server, io } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => io.close(() => server.close(resolve))));
  const socket = Client(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'] });
  t.after(() => socket.close());
  await new Promise((resolve) => socket.on('connect', resolve));
  const joined = await emit(socket, 'joinRoom', { name: '最初の参加者' });
  assert.equal(joined.ok, true);
  assert.equal((await emit(socket, 'leaveRoom')).ok, true);
  const statePromise = nextState(socket);
  const rejoined = await emit(socket, 'joinRoom', { name: '新しい参加者' });
  assert.equal(rejoined.ok, true);
  const state = await statePromise;
  assert.equal(state.isHost, true);
  assert.equal(state.players.length, 1);
  assert.equal((await emit(socket, 'leaveRoom')).ok, true);
  assert.equal((await emit(socket, 'reconnectRoom', { sessionId: joined.sessionId })).ok, false);
});
