const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom, makePlayer, CARD_DEFS } = require('./game');

function createAppServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });
  const rooms = new Map();
  const disconnectTimers = new Map();
  const accessKey = String(options.accessKey ?? process.env.ACCESS_KEY ?? '');
  const accessAttempts = new Map();

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.get('/api/access', (_req, res) => res.json({ required: Boolean(accessKey) }));
  app.get('/api/cards', (_req, res) => res.json(CARD_DEFS));

  function code() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let value;
    do { value = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); } while (rooms.has(value));
    return value;
  }

  function cleanName(input) {
    const name = String(input || '').trim().replace(/[<>]/g, '').slice(0, 16);
    if (!name) throw new Error('名前を入力してください。');
    return name;
  }

  function emitRoom(room) {
    for (const player of room.players) {
      if (player.socketId && player.connected) io.to(player.socketId).emit('state', room.publicState(player.sessionId));
    }
  }

  function locate(socket) {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.bySession(socket.data.sessionId);
    if (!room || !player) throw new Error('ルーム情報が見つかりません。');
    return { room, player };
  }

  function keysMatch(input) {
    const expected = Buffer.from(accessKey);
    const received = Buffer.from(String(input || ''));
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }

  function requireAuthorized(socket) {
    if (!socket.data.authorized) throw new Error('アクセスキーを入力してください。');
  }

  function reply(ack, fn) {
    try { ack?.({ ok: true, ...fn() }); } catch (error) { ack?.({ ok: false, error: error.message }); }
  }

  io.on('connection', (socket) => {
    socket.data.authorized = !accessKey;
    socket.on('unlock', (data, ack) => reply(ack, () => {
      if (!accessKey) { socket.data.authorized = true; return {}; }
      const address = socket.handshake.address || 'unknown';
      const now = Date.now();
      let attempts = accessAttempts.get(address);
      if (!attempts || attempts.resetAt <= now) attempts = { count: 0, resetAt: now + 15 * 60_000 };
      if (attempts.count >= 10) throw new Error('試行回数が多すぎます。15分後にお試しください。');
      if (!keysMatch(data?.accessKey)) {
        attempts.count += 1;
        accessAttempts.set(address, attempts);
        throw new Error('アクセスキーが違います。');
      }
      accessAttempts.delete(address);
      socket.data.authorized = true;
      return {};
    }));

    socket.on('createRoom', (data, ack) => reply(ack, () => {
      requireAuthorized(socket);
      const roomCode = code();
      const player = makePlayer(cleanName(data?.name), socket.id, undefined, data?.color);
      const room = new GameRoom(roomCode, player, { targetScore: Number(data?.targetScore) || 3 });
      rooms.set(roomCode, room);
      socket.data = { roomCode, sessionId: player.sessionId };
      socket.join(roomCode);
      room.addPublic(`${player.name} がルームを作成しました。`);
      emitRoom(room);
      return { roomCode, sessionId: player.sessionId };
    }));

    socket.on('joinRoom', (data, ack) => reply(ack, () => {
      requireAuthorized(socket);
      const roomCode = String(data?.roomCode || '').trim().toUpperCase();
      const room = rooms.get(roomCode);
      if (!room) throw new Error('ルームが見つかりません。');
      const player = makePlayer(cleanName(data?.name), socket.id, undefined, data?.color);
      room.addPlayer(player);
      socket.data = { roomCode, sessionId: player.sessionId };
      socket.join(roomCode);
      emitRoom(room);
      return { roomCode, sessionId: player.sessionId };
    }));

    socket.on('reconnectRoom', (data, ack) => reply(ack, () => {
      requireAuthorized(socket);
      const roomCode = String(data?.roomCode || '').trim().toUpperCase();
      const room = rooms.get(roomCode);
      if (!room) throw new Error('ルームの有効期限が切れています。');
      const player = room.reconnect(data?.sessionId, socket.id);
      const timerKey = `${roomCode}:${player.sessionId}`;
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
      socket.data = { roomCode, sessionId: player.sessionId };
      socket.join(roomCode);
      emitRoom(room);
      return { roomCode, sessionId: player.sessionId };
    }));

    socket.on('setScore', (data, ack) => reply(ack, () => {
      const { room, player } = locate(socket);
      room.setTargetScore(player.sessionId, data?.targetScore);
      emitRoom(room);
      return {};
    }));
    socket.on('startMatch', (_data, ack) => reply(ack, () => {
      const { room, player } = locate(socket);
      room.startMatch(player.sessionId);
      emitRoom(room);
      return {};
    }));
    socket.on('playCard', (data, ack) => reply(ack, () => {
      const { room, player } = locate(socket);
      room.play(player.sessionId, data || {});
      emitRoom(room);
      return {};
    }));
    socket.on('resolveEffect', (data, ack) => reply(ack, () => {
      const { room, player } = locate(socket);
      room.resolveEffect(player.sessionId, data || {});
      emitRoom(room);
      return {};
    }));
    socket.on('leaveRoom', (_data, ack) => reply(ack, () => {
      const { room, player } = locate(socket);
      room.leaveRoom(player.sessionId);
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.sessionId = null;
      emitRoom(room);
      if (!room.players.some((p) => p.connected)) rooms.delete(room.code);
      return {};
    }));
    socket.on('nextRound', (_data, ack) => reply(ack, () => {
      const { room, player } = locate(socket);
      room.startRound(player.sessionId);
      emitRoom(room);
      return {};
    }));
    socket.on('resetMatch', (_data, ack) => reply(ack, () => {
      const { room, player } = locate(socket);
      room.resetMatch(player.sessionId);
      emitRoom(room);
      return {};
    }));

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data?.roomCode);
      const sessionId = socket.data?.sessionId;
      const player = room?.bySession(sessionId);
      if (!room || !player || player.socketId !== socket.id) return;
      room.disconnect(sessionId);
      emitRoom(room);
      const timerKey = `${room.code}:${sessionId}`;
      const timer = setTimeout(() => {
        room.expireDisconnected(sessionId);
        emitRoom(room);
        disconnectTimers.delete(timerKey);
        if (!room.players.some((p) => p.connected)) rooms.delete(room.code);
      }, 60_000);
      timer.unref?.();
      disconnectTimers.set(timerKey, timer);
    });
  });

  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createAppServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Royal Secret listening on ${port}`));
}

module.exports = { createAppServer };
