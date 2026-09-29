const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, makePlayer, CARD_DEFS, PLAYER_COLORS } = require('../game');

const card = (value, id = `${value}-${Math.random()}`) => ({ id, value, name: CARD_DEFS[value].name, effect: CARD_DEFS[value].effect });
function roomWith(count = 2) {
  const players = Array.from({ length: count }, (_, i) => makePlayer(`P${i + 1}`, `socket-${i + 1}`, `session-${i + 1}`));
  const room = new GameRoom('ABCDE', players[0], { random: () => 0.01, targetScore: 3 });
  players.slice(1).forEach((p) => room.addPlayer(p));
  return { room, players };
}
function turnRoom(actorHand, targetHand, extra = {}) {
  const { room, players } = roomWith(2);
  Object.assign(room, { phase: 'turn', currentPlayerId: players[0].id, deck: [card(1,'deck-a'), card(2,'deck-b')], removedCard: card(3,'removed'), ...extra });
  players[0].alive = players[1].alive = true;
  players[0].hand = actorHand.map((v, i) => card(v, `a-${i}`));
  players[1].hand = targetHand.map((v, i) => card(v, `b-${i}`));
  return { room, actor: players[0], target: players[1] };
}
function playTarget(room, actor, target, cardId, guess) {
  room.play(actor.sessionId, { cardId });
  assert.equal(room.phase, 'effect');
  room.resolveEffect(actor.sessionId, { targetId: target.id, guess });
}

test('2人と5人でマッチを開始できる', () => {
  for (const count of [2, 5]) {
    const { room, players } = roomWith(count);
    room.startMatch(players[0].sessionId);
    assert.equal(room.phase, 'turn');
    assert.equal(room.players.filter((p) => p.alive).length, count);
    assert.equal(room.players.reduce((n, p) => n + p.hand.length, 0), count + 1);
  }
});

test('兵士の的中で対象が脱落し、外れでは生存する', () => {
  let ctx = turnRoom([1, 4], [6]);
  ctx.room.play(ctx.actor.sessionId, { cardId: 'a-0' });
  assert.equal(ctx.target.alive, true);
  assert.equal(ctx.actor.played.at(-1).value, 1);
  ctx.room.resolveEffect(ctx.actor.sessionId, { targetId: ctx.target.id, guess: 6 });
  assert.equal(ctx.target.alive, false);
  assert.match(ctx.room.publicLog.find((l) => l.kind === 'effect' && /兵士/.test(l.text)).text, /P1 → P2.*「6」.*的中/);
  ctx = turnRoom([1, 4], [6]);
  playTarget(ctx.room, ctx.actor, ctx.target, 'a-0', 5);
  assert.equal(ctx.target.alive, true);
  assert.match(ctx.room.publicLog.find((l) => l.kind === 'effect' && /兵士/.test(l.text)).text, /P1 → P2.*「5」.*外れ/);
});

test('道化の確認結果は使用者だけに見える', () => {
  const { room, actor, target } = turnRoom([2, 4], [8]);
  playTarget(room, actor, target, 'a-0');
  assert.match(room.publicLog.find((l) => l.kind === 'effect' && /道化/.test(l.text)).text, /P1 → P2/);
  assert.match(room.publicState(actor.sessionId).privateLog.at(-1).text, /姫（8）/);
  assert.equal(room.publicState(actor.sessionId).secretNotice.card.value, 8);
  assert.equal(room.publicState(actor.sessionId).secretNotice.targetName, target.name);
  assert.equal(room.publicState(target.sessionId).privateLog.some((l) => /姫（8）/.test(l.text)), false);
  assert.equal(room.publicState(target.sessionId).secretNotice, null);
  assert.equal(room.publicLog.some((l) => /姫（8）/.test(l.text)), false);
});

test('騎士は小さい方だけ脱落し、同値なら両者生存', () => {
  let ctx = turnRoom([3, 4], [6]);
  playTarget(ctx.room, ctx.actor, ctx.target, 'a-0');
  assert.equal(ctx.actor.alive, false);
  assert.equal(ctx.target.alive, true);
  ctx = turnRoom([3, 6], [6]);
  playTarget(ctx.room, ctx.actor, ctx.target, 'a-0');
  assert.equal(ctx.actor.alive, true);
  assert.equal(ctx.target.alive, true);
});

test('僧侶の保護中は対象外で、次の自分の手番開始に解除', () => {
  const { room, actor, target } = turnRoom([4, 2], [1]);
  room.play(actor.sessionId, { cardId: 'a-0' });
  assert.equal(actor.protected, true);
  assert.equal(room.validTargets(target).includes(actor), false);
  room.currentPlayerId = actor.id;
  actor.hand = [card(2,'protect-hand')]; room.deck = [card(3,'protect-draw')];
  room.beginTurn();
  assert.equal(actor.protected, false);
});

test('魔術師は残り札を公開して交換し、山札空なら除外札を使う', () => {
  const { room, actor, target } = turnRoom([5, 4], [2], { deck: [] });
  room.play(actor.sessionId, { cardId: 'a-0' });
  assert.equal(actor.played.some((c) => c.value === 4 && c.reason === 'magic'), true);
  assert.equal(actor.hand[0].value, 3);
  assert.equal(room.removedCard, null);
  assert.equal(target.alive, true);
});

test('魔術師で姫を捨てると脱落する', () => {
  const { room, actor } = turnRoom([5, 8], [2]);
  room.play(actor.sessionId, { cardId: 'a-0' });
  assert.equal(actor.alive, false);
});

test('将軍の交換内容は当事者だけに見え、公開ログには漏れない', () => {
  const { room, actor, target } = turnRoom([6, 8], [7]);
  playTarget(room, actor, target, 'a-0');
  assert.equal(actor.hand[0].value, 7);
  assert.equal(target.hand[0].value, 8);
  assert.equal(room.publicLog.some((l) => /姫|大臣/.test(l.text)), false);
  assert.equal(room.publicState(actor.sessionId).privateLog.some((l) => /大臣（7）/.test(l.text)), true);
  assert.equal(room.publicState(target.sessionId).privateLog.some((l) => /姫（8）/.test(l.text)), true);
});

test('大臣を持ちドロー後合計12以上ならカード選択前に脱落', () => {
  const { room, actor } = turnRoom([7], [2], { deck: [card(5,'fatal-draw')] });
  room.currentPlayerId = actor.id;
  room.beginTurn();
  assert.equal(actor.alive, false);
  assert.equal(actor.played.filter((c) => c.reason === 'eliminated').length, 2);
});

test('大臣をドローして合計12になっても、そのドローでは脱落しない', () => {
  const { room, actor } = turnRoom([5], [2], { deck: [card(7,'minister-draw')] });
  room.currentPlayerId = actor.id;
  room.beginTurn();
  assert.equal(actor.alive, true);
  assert.deepEqual(actor.hand.map((c) => c.value), [5, 7]);
});

test('将軍で大臣を受け取った時は生存し、次に大臣を持ってドローした時だけ判定する', () => {
  const { room, actor, target } = turnRoom([6, 4], [7], { deck: [card(1,'target-draw')] });
  playTarget(room, actor, target, 'a-0');
  assert.equal(actor.alive, true);
  assert.equal(actor.hand[0].value, 7);
  assert.match(room.publicState(actor.sessionId).privateLog.at(-1).text, /交換時には判定されません/);

  room.phase = 'turn';
  room.currentPlayerId = actor.id;
  room.deck = [card(5,'minister-fatal-draw')];
  room.beginTurn();
  assert.equal(actor.alive, false);
});

test('姫を通常プレイすると脱落する', () => {
  const { room, actor } = turnRoom([8, 2], [1]);
  room.play(actor.sessionId, { cardId: 'a-0' });
  assert.equal(actor.alive, false);
});

test('山札切れは手札値、次に公開札合計で判定し得点する', () => {
  const { room, players } = roomWith(3);
  room.phase = 'turn'; room.targetScore = 2;
  players.forEach((p) => { p.alive = true; });
  players[0].hand = [card(6)]; players[0].played = [card(1)];
  players[1].hand = [card(6)]; players[1].played = [card(4)];
  players[2].hand = [card(5)]; players[2].played = [card(8)];
  room.finishShowdown();
  assert.equal(players[1].score, 1);
  assert.equal(room.phase, 'round_over');
});

test('最終同点なら全員得点し、規定点到達でマッチ終了', () => {
  const { room, players } = roomWith(2);
  room.phase = 'turn'; room.targetScore = 1;
  players.forEach((p) => { p.alive = true; p.hand = [card(6)]; p.played = [card(2)]; });
  room.finishShowdown();
  assert.deepEqual(players.map((p) => p.score), [1, 1]);
  assert.equal(room.phase, 'match_over');
});

test('他プレイヤー向け状態に手札と秘密ログが漏れない', () => {
  const { room, actor, target } = turnRoom([2, 4], [8]);
  playTarget(room, actor, target, 'a-0');
  const targetView = room.publicState(target.sessionId);
  assert.equal(targetView.hand.length, 2); // action advanced and target drew
  assert.equal(targetView.players.some((p) => Object.hasOwn(p, 'hand')), false);
  assert.equal(targetView.privateLog.some((l) => /姫（8）/.test(l.text)), false);
});

test('対象型カードは公開後に対象を選び、使用者だけが選択情報を受け取る', () => {
  const { room, actor, target } = turnRoom([2, 4], [8]);
  room.play(actor.sessionId, { cardId: 'a-0' });
  assert.equal(room.phase, 'effect');
  assert.equal(actor.played.at(-1).value, 2);
  assert.equal(room.publicState(actor.sessionId).pendingAction.card.value, 2);
  assert.equal(room.publicState(target.sessionId).pendingAction, null);
  room.resolveEffect(actor.sessionId, { targetId: target.id });
  assert.notEqual(room.phase, 'effect');
});

test('タイトルへ戻ると待機ルームから即退出しホストが移る', () => {
  const { room, players } = roomWith(2);
  room.leaveRoom(players[0].sessionId);
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].id, players[1].id);
  assert.equal(room.hostSessionId, players[1].sessionId);
});

test('プレイヤー色は許可された10色だけを使用する', () => {
  const selected = makePlayer('色付き', 'socket', 'session', PLAYER_COLORS[7]);
  const invalid = makePlayer('不正色', 'socket', 'session', 'red;display:none');
  assert.equal(selected.color, PLAYER_COLORS[7]);
  assert.equal(invalid.color, PLAYER_COLORS[0]);
  assert.equal(PLAYER_COLORS.length, 10);
});
