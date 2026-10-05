const socket = io();
const $ = (id) => document.getElementById(id);
let state = null;
let selectedCardId = null;
let toastTimer;
const playerColors = ['#e15b64', '#f28e2b', '#edc948', '#59a14f', '#2a9d8f', '#4e79a7', '#7b6fd0', '#b07aa1', '#d37295', '#9c755f'];
let selectedColor = localStorage.getItem('royal-secret-color');
if (!playerColors.includes(selectedColor)) selectedColor = playerColors[5];
let cardDefs = {};
let lastSecretNoticeId = null;
let cardPlayQueue = [];
let cardPlayTimer;
let cardPlayActive = false;
let cardPlayBaseline = true;
let activeTargetEffect = null;
const cardArtPaths = {
  1: '/assets/cards/soldier.webp',
  2: '/assets/cards/jester.webp',
  3: '/assets/cards/knight.webp',
  4: '/assets/cards/priest.webp',
  5: '/assets/cards/wizard.webp',
  6: '/assets/cards/general.webp',
  7: '/assets/cards/minister.webp',
  8: '/assets/cards/princess.webp'
};

const storageKey = 'royal-secret-session';
let session = JSON.parse(localStorage.getItem(storageKey) || 'null');

function call(event, data = {}) {
  return new Promise((resolve) => socket.emit(event, data, (result) => {
    if (!result?.ok) showToast(result?.error || '操作に失敗しました。');
    resolve(result);
  }));
}

function remember(result) {
  if (result?.ok) {
    session = { sessionId: result.sessionId };
    localStorage.setItem(storageKey, JSON.stringify(session));
  }
}

function showToast(text) {
  const el = $('toast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function showHome() { clearCardPlays(); cardPlayBaseline = true; $('homeView').classList.remove('hidden'); $('gameView').classList.add('hidden'); $('titleButton').classList.add('hidden'); }
function enterGame() { $('homeView').classList.add('hidden'); $('gameView').classList.remove('hidden'); $('titleButton').classList.remove('hidden'); }
function escape(text) { const div = document.createElement('div'); div.textContent = text ?? ''; return div.innerHTML; }
function cardArt(value, name, className = 'card-art') {
  return `<img class="${className}" src="${cardArtPaths[value]}" alt="${escape(name)}のイラスト" loading="lazy" draggable="false">`;
}

function renderColorPicker() {
  $('colorPicker').innerHTML = playerColors.map((color, index) => `<button type="button" class="color-choice ${color === selectedColor ? 'selected' : ''}" style="--choice:${color}" data-color="${color}" role="radio" aria-checked="${color === selectedColor}" aria-label="色 ${index + 1}"></button>`).join('');
  document.querySelectorAll('[data-color]').forEach((button) => button.onclick = () => {
    selectedColor = button.dataset.color;
    localStorage.setItem('royal-secret-color', selectedColor);
    renderColorPicker();
  });
}

$('joinButton').onclick = async () => {
  const result = await call('joinRoom', { name: $('nameInput').value, color: selectedColor });
  remember(result); if (result?.ok) enterGame();
};
$('titleButton').onclick = async () => {
  if (state) await call('leaveRoom');
  localStorage.removeItem(storageKey); session = null; state = null; selectedCardId = null; showHome();
};

socket.on('connect', async () => {
  if (session?.sessionId) {
    const result = await call('reconnectRoom', session);
    if (result?.ok) enterGame(); else { session = null; localStorage.removeItem(storageKey); showHome(); }
  } else showHome();
});
socket.on('state', (next) => {
  const plays = collectCardPlays(next);
  state = next;
  selectedCardId = state.hand.some((c) => c.id === selectedCardId) ? selectedCardId : null;
  enterGame(); render();
  cardPlayQueue.push(...plays);
  showNextCardPlay();
  showSecretNotice(state.secretNotice);
});
socket.on('disconnect', () => { clearCardPlays(); cardPlayBaseline = true; });

function clearCardPlays() {
  clearTimeout(cardPlayTimer);
  cardPlayQueue = [];
  cardPlayActive = false;
  $('cardPlayNotice').classList.add('hidden');
  $('cardPlayNotice').replaceChildren();
  activeTargetEffect = null;
  $('targetEffectLayer').classList.add('hidden');
  $('targetEffectLayer').replaceChildren();
}

function collectCardPlays(next) {
  if (cardPlayBaseline || !state || state.viewerId !== next.viewerId || state.roundNumber !== next.roundNumber || next.phase === 'lobby') {
    clearCardPlays();
    cardPlayBaseline = false;
    return [];
  }
  const seen = new Set(state.players.flatMap((p) => p.played.map((c) => c.id)));
  const plays = next.players.flatMap((player) => player.played
    .filter((card) => card.reason === 'play' && !seen.has(card.id))
    .map((card) => {
      const handCard = [...$('handArea').children].find((el) => el.dataset.cardId === card.id);
      const playerIndex = state.players.findIndex((p) => p.id === player.id);
      const source = handCard || $('players').children[playerIndex];
      const rect = source?.getBoundingClientRect();
      return { card, player, x: rect ? rect.left + rect.width / 2 - window.innerWidth / 2 : 0,
        y: rect ? rect.top + rect.height / 2 - window.innerHeight / 2 : 80 };
    })).sort((a, b) => a.card.order - b.card.order);
  const seenLogs = new Set(state.publicLog.map((log) => log.id));
  const effects = next.publicLog.filter((log) => log.targetEffect && !seenLogs.has(log.id)).map((log) => {
    const effect = log.targetEffect;
    const player = next.players.find((p) => p.id === effect.actorId) || state.players.find((p) => p.id === effect.actorId);
    const target = next.players.find((p) => p.id === effect.targetId) || state.players.find((p) => p.id === effect.targetId);
    return { type: 'target', player, target, effect, result: log.text };
  }).filter((event) => event.player && event.target);
  return [...plays, ...effects];
}

function showNextCardPlay() {
  if (cardPlayActive || !cardPlayQueue.length) return;
  cardPlayActive = true;
  const event = cardPlayQueue.shift();
  if (event.type === 'target') { showTargetEffect(event); return; }
  const { card, player, x, y } = event;
  const notice = $('cardPlayNotice');
  notice.style.setProperty('--play-x', `${x}px`);
  notice.style.setProperty('--play-y', `${y}px`);
  notice.style.setProperty('--player-color', player.color);
  notice.innerHTML = `<div class="card-play-caption"><strong>${escape(player.name)}</strong><span>がカードを使用</span></div>
    <div class="card-play-card">${cardArt(card.value, card.name).replace('loading="lazy"', 'loading="eager"')}<div class="card-shade"></div>
      <div class="card-top"><span class="card-value">${card.value}</span><span class="card-name">${escape(card.name)}</span></div>
      <div class="card-effect">${escape(card.effect)}</div></div>`;
  notice.classList.remove('hidden');
  cardPlayTimer = setTimeout(() => {
    notice.classList.add('hidden');
    notice.replaceChildren();
    finishCardAnimation();
  }, 2300);
}

function finishCardAnimation() {
  cardPlayActive = false;
  if (cardPlayQueue.length) showNextCardPlay();
  else showSecretNotice(state?.secretNotice);
}

function showTargetEffect(event) {
  activeTargetEffect = event;
  const { player, target, effect, result } = event;
  const knight = effect.cardValue === 3;
  const layer = $('targetEffectLayer');
  layer.style.setProperty('--actor-color', player.color);
  layer.style.setProperty('--target-color', target.color);
  layer.innerHTML = `<svg class="target-effect-arrow" aria-hidden="true"><defs><marker id="targetArrowHead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="currentColor"/></marker></defs><line id="targetEffectLine" marker-end="url(#targetArrowHead)"/></svg>
    <div id="targetActorFrame" class="target-effect-frame actor-frame"><span>使用者</span></div>
    <div id="targetRecipientFrame" class="target-effect-frame recipient-frame"><span>対象の手札</span></div>
    <div class="target-effect-notice" role="status" aria-live="polite" aria-atomic="true">
      ${cardArt(effect.cardValue, knight ? '騎士' : '兵士', 'target-effect-art').replace('loading="lazy"', 'loading="eager"')}
      <strong class="target-effect-title">${knight ? '騎士 · 手札を比較' : `兵士 ·「${effect.guess}」を予想`}</strong>
      <div class="target-effect-people"><div><small>使用者</small><strong style="color:${player.color}">${escape(player.name)}</strong></div><b aria-hidden="true">→</b><div><small>対象</small><strong style="color:${target.color}">${escape(target.name)}</strong></div></div>
      <div class="target-effect-hands" aria-hidden="true">${knight ? '<span class="effect-card-back">?</span><b>⚔</b>' : '<b>➜</b>'}<span class="effect-card-back">?</span></div>
      <p>${escape(result)}</p>
    </div>`;
  layer.classList.remove('hidden');
  positionTargetEffect();
  cardPlayTimer = setTimeout(() => {
    activeTargetEffect = null;
    layer.classList.add('hidden');
    layer.replaceChildren();
    finishCardAnimation();
  }, 3000);
}

function positionTargetEffect() {
  if (!activeTargetEffect) return;
  const rectFor = (id) => $('players').children[state.players.findIndex((p) => p.id === id)]?.getBoundingClientRect();
  const actorRect = rectFor(activeTargetEffect.player.id);
  const targetRect = rectFor(activeTargetEffect.target.id);
  const positionFrame = (id, rect) => {
    const frame = $(id);
    frame.classList.toggle('hidden', !rect);
    if (rect) Object.assign(frame.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  };
  positionFrame('targetActorFrame', actorRect);
  positionFrame('targetRecipientFrame', targetRect);
  const line = $('targetEffectLine');
  line.classList.toggle('hidden', !actorRect || !targetRect);
  if (actorRect && targetRect) {
    line.setAttribute('x1', actorRect.left + actorRect.width / 2);
    line.setAttribute('y1', actorRect.top + actorRect.height / 2);
    line.setAttribute('x2', targetRect.left + targetRect.width / 2);
    line.setAttribute('y2', targetRect.top + targetRect.height / 2);
  }
}
window.addEventListener('resize', positionTargetEffect);
window.addEventListener('scroll', positionTargetEffect, { passive: true, capture: true });

function render() {
  $('deckCount').textContent = state.phase === 'lobby' ? '—' : state.deckCount;
  const labels = { lobby:'待機中', turn:'対戦中', effect:'効果選択', round_over:'ラウンド終了', match_over:'マッチ終了' };
  $('phaseBadge').textContent = labels[state.phase] || state.phase;
  const current = state.players.find((p) => p.id === state.currentPlayerId);
  $('turnStatus').textContent = ['turn','effect'].includes(state.phase) ? (current?.id === state.viewerId ? 'あなたの手番です' : `${current?.name || ''} の手番`) : `先取 ${state.targetScore}点`;
  renderPlayers(); renderAction(); renderHand(); renderLogs();
  positionTargetEffect();
}

function renderPlayers() {
  $('players').innerHTML = state.players.map((p) => `
    <article class="player ${p.id === state.currentPlayerId ? 'current' : ''} ${p.id === state.viewerId ? 'me' : ''}" style="--player-color:${p.color}">
      <div class="player-head"><span class="avatar">${escape(p.name.charAt(0))}</span><span class="player-name">${escape(p.name)}</span><span class="score">${p.score} pt</span></div>
      <div class="tags">
        ${state.phase !== 'lobby' ? `<span class="tag ${p.alive ? '' : 'out'}">${p.alive ? '生存' : '脱落'}</span>` : ''}
        ${p.protected ? '<span class="tag safe">加護</span>' : ''}${!p.connected ? '<span class="tag offline">切断中</span>' : ''}
      </div>
      <div class="history">${p.played.length ? p.played.map((c) => `<div class="mini-card ${c.reason === 'magic' ? 'magic' : ''} ${c.reason === 'eliminated' ? 'revealed' : ''}">${cardArt(c.value, c.name, 'mini-card-art')}<strong>${c.value}</strong><span>${escape(c.name)}</span></div>`).join('') : '<span class="empty">公開札なし</span>'}</div>
    </article>`).join('');
}

function renderAction() {
  const panel = $('actionPanel');
  if (state.phase === 'lobby') {
    panel.innerHTML = `<div class="lobby-controls"><div class="action-copy"><h3>${state.players.length}/5人が参加中</h3><p>${state.isHost ? '勝利点を決めて開始してください。' : 'ホストの開始を待っています。'}</p></div>
      ${state.isHost ? `<label>勝利点<select id="scoreSelect">${[1,2,3,4,5,6,7,8,9,10].map((n) => `<option ${n === state.targetScore ? 'selected' : ''}>${n}</option>`).join('')}</select></label><button id="startButton" class="primary" ${state.players.filter((p)=>p.connected).length < 2 ? 'disabled' : ''}>対戦を開始</button>` : ''}</div>`;
    if (state.isHost) {
      $('scoreSelect').onchange = (e) => call('setScore', { targetScore: Number(e.target.value) });
      $('startButton').onclick = () => call('startMatch');
    }
  } else if (state.phase === 'round_over') {
    panel.innerHTML = `<div class="action-copy"><h3>ラウンド終了</h3><p>${state.isHost ? '準備ができたら次のラウンドへ。' : 'ホストの操作を待っています。'}</p>${state.isHost ? '<button id="nextButton" class="primary">次のラウンド</button>' : ''}</div>`;
    if (state.isHost) $('nextButton').onclick = () => call('nextRound');
  } else if (state.phase === 'match_over') {
    const top = Math.max(...state.players.map((p) => p.score)); const winners = state.players.filter((p)=>p.score===top).map((p)=>p.name).join('・');
    panel.innerHTML = `<div class="action-copy"><h3>♛ ${escape(winners)} の勝利</h3><p>マッチが終了しました。</p>${state.isHost ? '<button id="resetButton" class="primary">新しいマッチ</button>' : ''}</div>`;
    if (state.isHost) $('resetButton').onclick = () => call('resetMatch');
  } else if (state.phase === 'effect' && state.currentPlayerId !== state.viewerId) {
    panel.innerHTML = '<div class="action-copy"><h3>効果の対象を選択中</h3><p>カードは場に出ました。使用者の選択を待っています。</p></div>';
  } else if (state.currentPlayerId !== state.viewerId) {
    panel.innerHTML = '<div class="action-copy"><h3>相手の手番です</h3><p>公開ログを見ながら、次の一手を考えましょう。</p></div>';
  } else if (state.phase === 'effect' && state.pendingAction) {
    renderTargetForm(panel);
  } else if (!selectedCardId) {
    panel.innerHTML = '<div class="action-copy"><h3>出すカードを選択</h3><p>手札のどちらかをタップしてください。</p></div>';
  } else renderEffectForm(panel);
}

function renderEffectForm(panel) {
  const card = state.hand.find((c) => c.id === selectedCardId);
  panel.innerHTML = `<form id="playForm" class="effect-form">
    <div class="action-copy"><h3>${escape(card.name)}を出す</h3><p>${escape(card.effect)}</p></div>
    <div></div><button class="primary" type="submit">場に出す</button></form>`;
  $('playForm').onsubmit = async (e) => {
    e.preventDefault(); const button = e.currentTarget.querySelector('button'); button.disabled = true;
    const result = await call('playCard', { cardId:card.id });
    if (!result?.ok) button.disabled = false;
  };
}

function renderTargetForm(panel) {
  const card = state.pendingAction.card;
  const targets = state.players.filter((p) => state.validTargets.includes(p.id));
  panel.innerHTML = `<form id="targetForm" class="effect-form">
    <div class="action-copy"><h3>${escape(card.name)}の対象を選択</h3><p>カードは公開済みです。続けて効果を解決します。</p></div>
    <label>対象<select id="targetSelect">${targets.map((p)=>`<option value="${p.id}">${escape(p.name)}</option>`).join('')}</select></label>
    ${card.value === 1 ? `<label>予想<select id="guessSelect">${[1,2,3,4,5,6,7,8].map((n)=>`<option>${n}</option>`).join('')}</select></label>` : ''}
    <button class="primary" type="submit">効果を解決</button></form>`;
  $('targetForm').onsubmit = async (e) => {
    e.preventDefault(); const button = e.currentTarget.querySelector('button'); button.disabled = true;
    const result = await call('resolveEffect', { targetId:$('targetSelect').value, guess:$('guessSelect')?.value });
    if (!result?.ok) button.disabled = false;
  };
}

function renderHand() {
  const canPlay = state.phase === 'turn' && state.currentPlayerId === state.viewerId;
  $('handArea').innerHTML = state.hand.map((c) => `<button class="card ${c.id === selectedCardId ? 'selected' : ''}" data-card-id="${c.id}" data-value="${c.value}" ${canPlay ? '' : 'disabled'}>${cardArt(c.value, c.name)}<div class="card-shade"></div><div class="card-top"><span class="card-value">${c.value}</span><span class="card-name">${escape(c.name)}</span></div><div class="card-effect">${escape(c.effect)}</div></button>`).join('');
  document.querySelectorAll('[data-card-id]').forEach((el) => el.onclick = () => { selectedCardId = el.dataset.cardId; renderAction(); renderHand(); });
}

function renderLogs() {
  const kindLabels = { play:'場に出したカード', pending:'対象選択中', effect:'効果結果' };
  const fill = (el, logs, empty) => { el.innerHTML = logs.length ? logs.slice().reverse().map((l)=>`<div class="log-entry log-${escape(l.kind || 'info')}">${kindLabels[l.kind] ? `<span class="log-kind">${kindLabels[l.kind]}</span>` : ''}<span>${escape(l.text)}</span></div>`).join('') : `<div class="empty">${empty}</div>`; };
  fill($('publicLog'), state.publicLog, 'まだログはありません'); fill($('privateLog'), state.privateLog, '秘密の情報はここに表示されます');
}

function showSecretNotice(notice) {
  if (cardPlayActive || cardPlayQueue.length) return;
  if (!notice || notice.id === lastSecretNoticeId || notice.type !== 'jester') return;
  lastSecretNoticeId = notice.id;
  $('secretTitle').textContent = notice.title;
  $('secretTarget').textContent = `${notice.targetName} の手札`;
  $('secretCard').innerHTML = `${cardArt(notice.card.value, notice.card.name)}<div class="card-shade"></div><div class="reveal-content"><strong>${notice.card.value}</strong><span>${escape(notice.card.name)}</span><p>${escape(notice.card.effect)}</p></div>`;
  if ($('secretDialog').open) $('secretDialog').close();
  $('secretDialog').showModal();
}

function renderRemainingCounts() {
  const seen = {};
  for (const player of state?.players || []) for (const card of player.played) seen[card.value] = (seen[card.value] || 0) + 1;
  $('remainingGrid').innerHTML = Object.entries(cardDefs).map(([value, def]) => {
    const remaining = Math.max(0, def.count - (seen[value] || 0));
    return `<div class="count-card">${cardArt(value, def.name, 'count-card-art')}<div><div class="count-name">${value}・${escape(def.name)}</div><strong>${remaining}</strong><small>全${def.count}枚 / 公開${seen[value] || 0}枚</small></div></div>`;
  }).join('');
}

document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => {
  document.querySelectorAll('.tab').forEach((t)=>t.classList.toggle('active',t===tab));
  $('publicLog').classList.toggle('hidden',tab.dataset.tab!=='public'); $('privateLog').classList.toggle('hidden',tab.dataset.tab!=='private');
});
const rulesDialog = $('rulesDialog'); $('rulesButton').onclick = () => rulesDialog.showModal(); $('closeRules').onclick = () => rulesDialog.close();
const remainingDialog = $('remainingDialog'); $('remainingButton').onclick = () => { renderRemainingCounts(); remainingDialog.showModal(); }; $('closeRemaining').onclick = () => remainingDialog.close();
$('closeSecret').onclick = () => $('secretDialog').close();
fetch('/api/cards').then((r)=>r.json()).then((defs) => { cardDefs = defs; $('cardGuide').innerHTML = Object.entries(defs).map(([value,d])=>`<div class="guide-row">${cardArt(value, d.name, 'guide-art')}<div><strong>${value}・${escape(d.name)} ×${d.count}</strong><p>${escape(d.effect)}</p></div></div>`).join(''); });
renderColorPicker();
