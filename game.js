const crypto = require('node:crypto');

const CARD_DEFS = {
  1: { name: '兵士', count: 5, effect: '相手の手札の数字を予想し、的中すれば脱落させる。' },
  2: { name: '道化', count: 2, effect: '相手の手札を自分だけ確認する。' },
  3: { name: '騎士', count: 2, effect: '相手と手札を秘密比較し、小さい方が脱落する。' },
  4: { name: '僧侶', count: 2, effect: '次の自分の手番開始まで、他者の効果から守られる。' },
  5: { name: '魔術師', count: 2, effect: '残りの手札を公開して捨て、新しい1枚を引く。' },
  6: { name: '将軍', count: 1, effect: '相手と残りの手札を秘密に交換する。' },
  7: { name: '大臣', count: 1, effect: '所持中、ドロー後の合計が12以上なら即脱落する。' },
  8: { name: '姫', count: 1, effect: '通常プレイまたは魔術師で捨てると脱落する。' }
};

const PLAYER_COLORS = ['#e15b64', '#f28e2b', '#edc948', '#59a14f', '#2a9d8f', '#4e79a7', '#7b6fd0', '#b07aa1', '#d37295', '#9c755f'];

function makeDeck() {
  const cards = [];
  for (const [value, def] of Object.entries(CARD_DEFS)) {
    for (let i = 0; i < def.count; i += 1) {
      cards.push({ id: crypto.randomUUID(), value: Number(value), name: def.name, effect: def.effect });
    }
  }
  return cards;
}

function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

class GameRoom {
  constructor(code, host, options = {}) {
    this.code = code;
    this.players = [host];
    this.hostSessionId = host.sessionId;
    const requestedScore = Number(options.targetScore);
    this.targetScore = Number.isInteger(requestedScore) && requestedScore >= 1 && requestedScore <= 10 ? requestedScore : 3;
    this.phase = 'lobby';
    this.roundNumber = 0;
    this.turnNumber = 0;
    this.currentPlayerId = null;
    this.deck = [];
    this.removedCard = null;
    this.pendingAction = null;
    this.publicLog = [];
    this.privateLogs = new Map();
    this.privateNotices = new Map();
    this.logSeq = 0;
    this.random = options.random || Math.random;
  }

  addPlayer(player) {
    if (this.phase !== 'lobby') throw new Error('対戦開始後は参加できません。');
    if (this.players.length >= 5) throw new Error('このルームは満員です。');
    if (this.players.some((p) => p.name.toLowerCase() === player.name.toLowerCase())) throw new Error('同じ名前は使えません。');
    this.players.push(player);
    this.addPublic(`${player.name} が参加しました。`);
  }

  setTargetScore(sessionId, score) {
    if (sessionId !== this.hostSessionId || this.phase !== 'lobby') throw new Error('ホストだけが変更できます。');
    const parsed = Number(score);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) throw new Error('勝利点は1〜10で指定してください。');
    this.targetScore = parsed;
  }

  startMatch(sessionId) {
    if (sessionId !== this.hostSessionId) throw new Error('ホストだけが開始できます。');
    if (this.phase !== 'lobby') throw new Error('マッチは待機画面から開始してください。');
    if (this.players.filter((p) => p.connected).length < 2) throw new Error('開始には2人以上必要です。');
    for (const p of this.players) p.score = 0;
    this.startRound(sessionId, true);
  }

  startRound(sessionId, first = false) {
    if (sessionId !== this.hostSessionId) throw new Error('ホストだけがラウンドを開始できます。');
    if (!first && this.phase !== 'round_over') throw new Error('今は次のラウンドを開始できません。');
    const active = this.players.filter((p) => p.connected);
    if (active.length < 2) throw new Error('接続中のプレイヤーが2人必要です。');
    this.roundNumber += 1;
    this.turnNumber = 0;
    this.publicLog = [];
    this.privateLogs = new Map();
    this.privateNotices = new Map();
    this.logSeq = 0;
    this.deck = shuffle(makeDeck(), this.random);
    this.removedCard = this.deck.pop();
    this.pendingAction = null;
    for (const p of this.players) {
      p.alive = p.connected;
      p.protected = false;
      p.hand = p.alive ? [this.deck.pop()] : [];
      p.played = [];
    }
    const starter = active[Math.floor(this.random() * active.length)];
    this.currentPlayerId = starter.id;
    this.phase = 'turn';
    this.addPublic(`第${this.roundNumber}ラウンド開始。${starter.name} が先手です。`);
    this.beginTurn();
  }

  beginTurn() {
    const player = this.currentPlayer();
    if (!player || !player.alive) return this.advanceTurn();
    if (player.protected) {
      player.protected = false;
      this.addPublic(`${player.name} の僧侶の加護が解けました。`);
    }
    this.turnNumber += 1;
    const drawn = this.deck.pop();
    if (!drawn) return this.finishShowdown();
    player.hand.push(drawn);
    this.addPublic(`${player.name} の手番です（山札 ${this.deck.length}枚）。`);
    if (player.hand.some((c) => c.value === 7) && player.hand.reduce((sum, c) => sum + c.value, 0) >= 12) {
      this.addPublic(`【大臣】${player.name}：ドロー後の手札合計が12以上になったため、即座に脱落しました。`, 'effect');
      this.eliminate(player, '大臣');
      return this.afterAction();
    }
  }

  validTargets(actor) {
    return this.players.filter((p) => p.alive && p.id !== actor.id && !p.protected);
  }

  play(sessionId, payload) {
    if (this.phase !== 'turn') throw new Error('現在はカードを出せません。');
    const actor = this.currentPlayer();
    if (!actor || actor.sessionId !== sessionId) throw new Error('あなたの手番ではありません。');
    const index = actor.hand.findIndex((c) => c.id === payload.cardId);
    if (index < 0) throw new Error('そのカードは手札にありません。');
    const card = actor.hand[index];
    actor.hand.splice(index, 1);
    actor.played.push({ ...card, reason: 'play', order: this.turnNumber });
    this.addPublic(`${actor.name} が ${card.name}（${card.value}）を場に出しました。`, 'play');
    const targets = this.validTargets(actor);
    if ([1, 2, 3, 6].includes(card.value) && targets.length) {
      this.phase = 'effect';
      this.pendingAction = { actorId: actor.id, card };
      this.addPublic(`【${card.name}】${actor.name} が効果の対象を選んでいます…。`, 'pending');
      return;
    }
    this.resolveCard(actor, card, null, null);
    this.afterAction();
  }

  resolveEffect(sessionId, payload) {
    if (this.phase !== 'effect' || !this.pendingAction) throw new Error('現在は対象を選べません。');
    const actor = this.currentPlayer();
    if (!actor || actor.sessionId !== sessionId || this.pendingAction.actorId !== actor.id) throw new Error('あなたが選択する効果ではありません。');
    const target = this.validTargets(actor).find((p) => p.id === payload.targetId);
    if (!target) throw new Error('有効な対象を選んでください。');
    const { card } = this.pendingAction;
    const guess = Number(payload.guess);
    if (card.value === 1 && (!Number.isInteger(guess) || guess < 1 || guess > 8)) throw new Error('予想は1〜8で指定してください。');
    this.pendingAction = null;
    this.phase = 'turn';
    this.resolveCard(actor, card, target, guess);
    this.afterAction();
  }

  resolveCard(actor, card, target, guess) {
    if ([1, 2, 3, 6].includes(card.value) && !target) {
      this.addPublic(`【${card.name}】${actor.name}：有効な対象がいないため、効果なし。`, 'effect');
      return;
    }
    if (card.value === 1) {
      if (target.hand[0]?.value === guess) {
        this.addPublic(`【兵士】${actor.name} → ${target.name}：手札を「${guess}」と予想 → 的中。${target.name} が脱落しました。`, 'effect');
        this.eliminate(target, '兵士');
      } else this.addPublic(`【兵士】${actor.name} → ${target.name}：手札を「${guess}」と予想 → 外れ。${target.name} は生存しています。`, 'effect');
    } else if (card.value === 2) {
      this.addPrivate(actor, `${target.name} の手札は ${this.cardLabel(target.hand[0])} です。`);
      this.privateNotices.set(actor.sessionId, {
        id: crypto.randomUUID(),
        type: 'jester',
        title: '道化の確認結果',
        targetName: target.name,
        card: target.hand[0]
      });
      this.addPublic(`【道化】${actor.name} → ${target.name}：手札を確認しました（内容は${actor.name}だけに表示）。`, 'effect');
    } else if (card.value === 3) {
      const own = actor.hand[0];
      const other = target.hand[0];
      this.addPrivate(actor, `${target.name} と比較：あなた ${this.cardLabel(own)} / 相手 ${this.cardLabel(other)}`);
      this.addPrivate(target, `${actor.name} と比較：あなた ${this.cardLabel(other)} / 相手 ${this.cardLabel(own)}`);
      if (own.value < other.value) {
        this.addPublic(`【騎士】${actor.name} ⇄ ${target.name}：手札を秘密比較 → ${actor.name} が小さく、脱落しました。`, 'effect');
        this.eliminate(actor, '騎士');
      } else if (other.value < own.value) {
        this.addPublic(`【騎士】${actor.name} ⇄ ${target.name}：手札を秘密比較 → ${target.name} が小さく、脱落しました。`, 'effect');
        this.eliminate(target, '騎士');
      } else this.addPublic(`【騎士】${actor.name} ⇄ ${target.name}：手札を秘密比較 → 同値。両者とも生存します。`, 'effect');
    } else if (card.value === 4) {
      actor.protected = true;
      this.addPublic(`【僧侶】${actor.name}：次の自分の手番まで、他者の効果から守られます。`, 'effect');
    } else if (card.value === 5) {
      const discarded = actor.hand.shift();
      if (discarded) {
        actor.played.push({ ...discarded, reason: 'magic', order: this.turnNumber });
        this.addPublic(`【魔術師】${actor.name}：残り手札の ${discarded.name}（${discarded.value}）を公開して捨てました。`, 'effect');
        if (discarded.value === 8) {
          this.addPublic(`【魔術師 → 姫】${actor.name}：姫を捨てたため脱落しました。`, 'effect');
          this.eliminate(actor, '姫');
          return;
        }
      }
      const replacement = this.deck.pop() || this.takeRemovedCard();
      if (replacement) {
        actor.hand.push(replacement);
        this.addPrivate(actor, `魔術師で ${this.cardLabel(replacement)} を引きました。`);
        this.addPublic(`【魔術師】${actor.name}：新しい手札を1枚引きました。`, 'effect');
      }
    } else if (card.value === 6) {
      const own = actor.hand[0];
      const other = target.hand[0];
      actor.hand[0] = other;
      target.hand[0] = own;
      this.addPublic(`【将軍】${actor.name} ⇄ ${target.name}：手札を交換しました（内容は当事者だけに表示）。`, 'effect');
      this.addPrivate(actor, `${target.name} と交換し、${this.cardLabel(other)} を受け取りました。`);
      this.addPrivate(target, `${actor.name} と交換し、${this.cardLabel(own)} を受け取りました。`);
    } else if (card.value === 8) {
      this.addPublic(`【姫】${actor.name}：姫を場に出したため脱落しました。`, 'effect');
      this.eliminate(actor, '姫');
    }
  }

  takeRemovedCard() {
    const card = this.removedCard;
    this.removedCard = null;
    return card;
  }

  eliminate(player, reason = '効果') {
    if (!player.alive) return;
    player.alive = false;
    player.protected = false;
    while (player.hand.length) {
      const revealed = player.hand.shift();
      player.played.push({ ...revealed, reason: 'eliminated', order: this.turnNumber });
      this.addPublic(`${player.name} の残り手札は ${revealed.name}（${revealed.value}）でした。`);
    }
    this.addPrivate(player, `${reason}により脱落しました。`);
  }

  afterAction() {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) return this.finishRound(alive, '最後まで生き残りました');
    if (this.deck.length === 0) return this.finishShowdown();
    this.advanceTurn();
  }

  advanceTurn() {
    const currentIndex = this.players.findIndex((p) => p.id === this.currentPlayerId);
    for (let step = 1; step <= this.players.length; step += 1) {
      const next = this.players[(currentIndex + step) % this.players.length];
      if (next.alive) {
        this.currentPlayerId = next.id;
        return this.beginTurn();
      }
    }
  }

  finishShowdown() {
    const alive = this.players.filter((p) => p.alive && p.hand[0]);
    if (!alive.length) return this.finishRound([], '生存者なし');
    for (const p of alive) this.addPublic(`${p.name} の最終手札：${this.cardLabel(p.hand[0])}`);
    const maxHand = Math.max(...alive.map((p) => p.hand[0].value));
    let tied = alive.filter((p) => p.hand[0].value === maxHand);
    if (tied.length > 1) {
      const sums = tied.map((p) => p.played.reduce((sum, c) => sum + c.value, 0));
      const maxSum = Math.max(...sums);
      tied = tied.filter((p) => p.played.reduce((sum, c) => sum + c.value, 0) === maxSum);
      this.addPublic('手札が同値のため、公開済みカードの合計で判定します。');
    }
    this.finishRound(tied, '山札切れの判定に勝利しました');
  }

  finishRound(winners, reason) {
    this.pendingAction = null;
    if (!winners.length) {
      this.phase = 'round_over';
      this.addPublic(`ラウンド終了：${reason}。得点者はいません。`);
      return;
    }
    for (const p of winners) p.score += 1;
    this.addPublic(`${winners.map((p) => p.name).join('・')} が1点獲得：${reason}。`);
    const matchWinners = winners.filter((p) => p.score >= this.targetScore);
    if (matchWinners.length) {
      this.phase = 'match_over';
      this.addPublic(`${matchWinners.map((p) => p.name).join('・')} が規定点に到達し、マッチ勝者です！`);
    } else this.phase = 'round_over';
  }

  disconnect(sessionId) {
    const player = this.bySession(sessionId);
    if (!player) return;
    player.connected = false;
    this.addPublic(`${player.name} の接続が切れました。60秒間再接続を待ちます。`);
  }

  leaveRoom(sessionId) {
    const player = this.bySession(sessionId);
    if (!player) return;
    player.connected = false;
    this.addPublic(`${player.name} がタイトルへ戻りました。`);
    if (['lobby', 'round_over', 'match_over'].includes(this.phase)) {
      this.players = this.players.filter((p) => p !== player);
    } else if (player.alive) {
      this.eliminate(player, '退出');
      if (this.pendingAction?.actorId === player.id) {
        this.pendingAction = null;
        this.phase = 'turn';
      }
      if (player.id === this.currentPlayerId || this.players.filter((p) => p.alive).length <= 1) this.afterAction();
    }
    if (this.hostSessionId === sessionId) {
      const nextHost = this.players.find((p) => p.connected);
      if (nextHost) {
        this.hostSessionId = nextHost.sessionId;
        this.addPublic(`${nextHost.name} が新しいホストになりました。`);
      }
    }
  }

  expireDisconnected(sessionId) {
    const player = this.bySession(sessionId);
    if (!player || player.connected) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((p) => p !== player);
    } else if (player.alive && ['turn', 'effect'].includes(this.phase)) {
      this.addPublic(`${player.name} は再接続しなかったため脱落しました。`);
      this.eliminate(player, '切断');
      if (this.pendingAction?.actorId === player.id) {
        this.pendingAction = null;
        this.phase = 'turn';
      }
      if (player.id === this.currentPlayerId) this.afterAction();
      else if (this.players.filter((p) => p.alive).length <= 1) this.afterAction();
    }
    if (this.hostSessionId === sessionId) {
      const nextHost = this.players.find((p) => p.connected);
      if (nextHost) {
        this.hostSessionId = nextHost.sessionId;
        this.addPublic(`${nextHost.name} が新しいホストになりました。`);
      }
    }
  }

  reconnect(sessionId, socketId) {
    const player = this.bySession(sessionId);
    if (!player) throw new Error('再接続情報が見つかりません。');
    player.socketId = socketId;
    player.connected = true;
    this.addPublic(`${player.name} が再接続しました。`);
    return player;
  }

  resetMatch(sessionId) {
    if (sessionId !== this.hostSessionId || this.phase !== 'match_over') throw new Error('ホストだけが新しいマッチを開始できます。');
    this.phase = 'lobby';
    this.roundNumber = 0;
    this.currentPlayerId = null;
    this.publicLog = [];
    for (const p of this.players) {
      p.score = 0;
      p.alive = false;
      p.hand = [];
      p.played = [];
      p.protected = false;
    }
    this.addPublic('新しいマッチの準備ができました。');
  }

  publicState(forSessionId) {
    const viewer = this.bySession(forSessionId);
    return {
      code: this.code,
      phase: this.phase,
      roundNumber: this.roundNumber,
      turnNumber: this.turnNumber,
      targetScore: this.targetScore,
      deckCount: this.deck.length,
      currentPlayerId: this.currentPlayerId,
      viewerId: viewer?.id,
      isHost: this.hostSessionId === forSessionId,
      hand: viewer?.hand || [],
      validTargets: viewer?.id === this.currentPlayerId && ['turn', 'effect'].includes(this.phase) ? this.validTargets(viewer).map((p) => p.id) : [],
      pendingAction: viewer?.id === this.pendingAction?.actorId ? { card: this.pendingAction.card } : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        alive: p.alive,
        protected: p.protected,
        connected: p.connected,
        played: p.played
      })),
      publicLog: this.publicLog.slice(-80),
      privateLog: (this.privateLogs.get(forSessionId) || []).slice(-30),
      secretNotice: this.privateNotices.get(forSessionId) || null
    };
  }

  currentPlayer() { return this.players.find((p) => p.id === this.currentPlayerId); }
  bySession(sessionId) { return this.players.find((p) => p.sessionId === sessionId); }
  cardLabel(card) { return card ? `${card.name}（${card.value}）` : 'なし'; }
  addPublic(text, kind = 'info') { this.publicLog.push({ id: ++this.logSeq, text, kind }); }
  addPrivate(player, text) {
    const logs = this.privateLogs.get(player.sessionId) || [];
    logs.push({ id: ++this.logSeq, text });
    this.privateLogs.set(player.sessionId, logs);
  }
}

function makePlayer(name, socketId, sessionId = crypto.randomUUID(), color = PLAYER_COLORS[0]) {
  const safeColor = PLAYER_COLORS.includes(color) ? color : PLAYER_COLORS[0];
  return { id: crypto.randomUUID(), sessionId, socketId, name, color: safeColor, connected: true, score: 0, alive: false, protected: false, hand: [], played: [] };
}

module.exports = { CARD_DEFS, PLAYER_COLORS, GameRoom, makeDeck, makePlayer, shuffle };
