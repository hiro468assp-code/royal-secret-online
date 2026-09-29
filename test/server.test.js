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

test('2クライアントが作成・参加・開始でき、相手の手札は配信されない', async (t) => {
  const { server, io } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => io.close(() => server.close(resolve))));
  const url = `http://127.0.0.1:${server.address().port}`;
  const host = Client(url, { transports: ['websocket'] });
  const guest = Client(url, { transports: ['websocket'] });
  t.after(() => { host.close(); guest.close(); });
  await Promise.all([new Promise((r) => host.on('connect', r)), new Promise((r) => guest.on('connect', r))]);

  const created = await emit(host, 'createRoom', { name: 'ホスト', color: '#2a9d8f', targetScore: 3 });
  assert.equal(created.ok, true);
  const hostJoined = nextState(host, (s) => s.players.length === 2);
  const joined = await emit(guest, 'joinRoom', { name: 'ゲスト', roomCode: created.roomCode });
  assert.equal(joined.ok, true);
  await hostJoined;

  const hostStarted = nextState(host, (s) => s.phase === 'turn');
  const guestStarted = nextState(guest, (s) => s.phase === 'turn');
  assert.equal((await emit(host, 'startMatch')).ok, true);
  const [hostState, guestState] = await Promise.all([hostStarted, guestStarted]);
  assert.equal(hostState.players.length, 2);
  assert.equal(hostState.players.find((p) => p.name === 'ホスト').color, '#2a9d8f');
  assert.equal(guestState.players.length, 2);
  assert.equal(hostState.players.some((p) => Object.hasOwn(p, 'hand')), false);
  assert.equal(guestState.players.some((p) => Object.hasOwn(p, 'hand')), false);
  assert.ok(hostState.hand.length >= 1 && hostState.hand.length <= 2);
  assert.ok(guestState.hand.length >= 1 && guestState.hand.length <= 2);
});

test('アクセスキーが設定されている場合は認証前のルーム操作を拒否する', async (t) => {
  const { server, io } = createAppServer({ accessKey: 'secret-test-key' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => io.close(() => server.close(resolve))));
  const socket = Client(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'] });
  t.after(() => socket.close());
  await new Promise((resolve) => socket.on('connect', resolve));

  const denied = await emit(socket, 'createRoom', { name: '侵入者' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /アクセスキー/);
  const wrong = await emit(socket, 'unlock', { accessKey: 'wrong' });
  assert.equal(wrong.ok, false);
  const unlocked = await emit(socket, 'unlock', { accessKey: 'secret-test-key' });
  assert.equal(unlocked.ok, true);
  const created = await emit(socket, 'createRoom', { name: '招待者' });
  assert.equal(created.ok, true);
  const left = await emit(socket, 'leaveRoom');
  assert.equal(left.ok, true);
  const createdAgain = await emit(socket, 'createRoom', { name: '再入室者' });
  assert.equal(createdAgain.ok, true, 'タイトルへ戻った後も同じ接続の認証状態を維持する');
});
