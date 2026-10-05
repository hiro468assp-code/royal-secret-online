const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom, makePlayer, CARD_DEFS } = require('./game');

function createAppServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });
  let sharedRoom = null;
  const disconnectTimers = new Map();

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: sharedRoom ? 1 : 0 }));
  app.get('/api/cards', (_req, res) => res.json(CARD_DEFS));

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
    const room = sharedRoom;
    const player = room?.bySession(socket.data.sessionId);
    if (!room || !player) throw new Error('ルーム情報が見つかりません。');
    return { room, player };
  }

  function reply(ack, fn) {
    try { ack?.({ ok: true, ...fn() }); } catch (error) { ack?.({ ok: false, error: error.message }); }
  }

  io.on('connection', (socket) => {
    socket.on('joinRoom', (data, ack) => reply(ack, () => {
      if (sharedRoom?.bySession(socket.data.sessionId)) throw new Error('すでに参加しています。');
      const player = makePlayer(cleanName(data?.name), socket.id, undefined, data?.color);
      if (!sharedRoom) {
        sharedRoom = new GameRoom(player);
        sharedRoom.addPublic(`${player.name} が参加しました。`);
      } else sharedRoom.addPlayer(player);
      socket.data.sessionId = player.sessionId;
      emitRoom(sharedRoom);
      return { sessionId: player.sessionId };
    }));

    socket.on('reconnectRoom', (data, ack) => reply(ack, () => {
      if (!sharedRoom) throw new Error('再接続情報の有効期限が切れています。');
      if (socket.data.sessionId && socket.data.sessionId !== data?.sessionId) throw new Error('すでに参加しています。');
      const player = sharedRoom.reconnect(data?.sessionId, socket.id);
      clearTimeout(disconnectTimers.get(player.sessionId));
      disconnectTimers.delete(player.sessionId);
      socket.data.sessionId = player.sessionId;
      emitRoom(sharedRoom);
      return { sessionId: player.sessionId };
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
      clearTimeout(disconnectTimers.get(player.sessionId));
      disconnectTimers.delete(player.sessionId);
      room.leaveRoom(player.sessionId);
      socket.data.sessionId = null;
      emitRoom(room);
      if (sharedRoom === room && !room.players.some((p) => p.connected)) sharedRoom = null;
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
      const room = sharedRoom;
      const sessionId = socket.data?.sessionId;
      const player = room?.bySession(sessionId);
      if (!room || !player || player.socketId !== socket.id) return;
      room.disconnect(sessionId);
      emitRoom(room);
      const timerKey = sessionId;
      const timer = setTimeout(() => {
        room.expireDisconnected(sessionId);
        emitRoom(room);
        disconnectTimers.delete(timerKey);
        if (sharedRoom === room && !room.players.some((p) => p.connected)) sharedRoom = null;
      }, 60_000);
      timer.unref?.();
      disconnectTimers.set(timerKey, timer);
    });
  });

  return { app, server, io };
}

if (require.main === module) {
  const { server } = createAppServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Royal Secret listening on ${port}`));
}

module.exports = { createAppServer };
