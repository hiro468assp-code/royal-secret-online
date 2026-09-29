const socket = io();
const $ = (id) => document.getElementById(id);
let state = null;
let selectedCardId = null;
let toastTimer;
let accessRequired = true;
let accessKey = sessionStorage.getItem('royal-secret-access') || '';
const playerColors = ['#e15b64', '#f28e2b', '#edc948', '#59a14f', '#2a9d8f', '#4e79a7', '#7b6fd0', '#b07aa1', '#d37295', '#9c755f'];
let selectedColor = localStorage.getItem('royal-secret-color');
if (!playerColors.includes(selectedColor)) selectedColor = playerColors[5];
let cardDefs = {};
let lastSecretNoticeId = null;

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
    session = { roomCode: result.roomCode, sessionId: result.sessionId };
    localStorage.setItem(storageKey, JSON.stringify(session));
  }
}

function showToast(text) {
  const el = $('toast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function showAccess() { $('accessView').classList.remove('hidden'); $('homeView').classList.add('hidden'); $('gameView').classList.add('hidden'); $('titleButton').classList.add('hidden'); }
function showHome() { $('accessView').classList.add('hidden'); $('homeView').classList.remove('hidden'); $('gameView').classList.add('hidden'); $('titleButton').classList.add('hidden'); }
function enterGame() { $('accessView').classList.add('hidden'); $('homeView').classList.add('hidden'); $('gameView').classList.remove('hidden'); $('titleButton').classList.remove('hidden'); }
function escape(text) { const div = document.createElement('div'); div.textContent = text ?? ''; return div.innerHTML; }

function renderColorPicker() {
  $('colorPicker').innerHTML = playerColors.map((color, index) => `<button type="button" class="color-choice ${color === selectedColor ? 'selected' : ''}" style="--choice:${color}" data-color="${color}" role="radio" aria-checked="${color === selectedColor}" aria-label="色 ${index + 1}"></button>`).join('');
  document.querySelectorAll('[data-color]').forEach((button) => button.onclick = () => {
    selectedColor = button.dataset.color;
    localStorage.setItem('royal-secret-color', selectedColor);
    renderColorPicker();
  });
}

$('createButton').onclick = async () => {
  const result = await call('createRoom', { name: $('nameInput').value, color: selectedColor, targetScore: 3 });
  remember(result); if (result?.ok) enterGame();
};
$('joinButton').onclick = async () => {
  const result = await call('joinRoom', { name: $('nameInput').value, color: selectedColor, roomCode: $('codeInput').value });
  remember(result); if (result?.ok) enterGame();
};
$('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ''); });
$('copyCode').onclick = async () => { await navigator.clipboard.writeText(state.code); showToast('ルームコードをコピーしました'); };
$('titleButton').onclick = async () => {
  if (state) await call('leaveRoom');
  localStorage.removeItem(storageKey); session = null; state = null; selectedCardId = null; showHome();
};

socket.on('connect', async () => {
  if (accessRequired) {
    if (!accessKey) return showAccess();
    const unlocked = await call('unlock', { accessKey });
    if (!unlocked?.ok) { accessKey = ''; sessionStorage.removeItem('royal-secret-access'); return showAccess(); }
  }
  if (session?.roomCode && session?.sessionId) {
    const result = await call('reconnectRoom', session);
    if (result?.ok) enterGame(); else { session = null; localStorage.removeItem(storageKey); }
  } else showHome();
});
socket.on('state', (next) => {
  state = next;
  selectedCardId = state.hand.some((c) => c.id === selectedCardId) ? selectedCardId : null;
  enterGame(); render(); showSecretNotice(state.secretNotice);
});

function render() {
  $('copyCode').textContent = state.code;
  $('deckCount').textContent = state.phase === 'lobby' ? '—' : state.deckCount;
  const labels = { lobby:'待機中', turn:'対戦中', effect:'効果選択', round_over:'ラウンド終了', match_over:'マッチ終了' };
  $('phaseBadge').textContent = labels[state.phase] || state.phase;
  const current = state.players.find((p) => p.id === state.currentPlayerId);
  $('turnStatus').textContent = ['turn','effect'].includes(state.phase) ? (current?.id === state.viewerId ? 'あなたの手番です' : `${current?.name || ''} の手番`) : `先取 ${state.targetScore}点`;
  renderPlayers(); renderAction(); renderHand(); renderLogs();
}

function renderPlayers() {
  $('players').innerHTML = state.players.map((p) => `
    <article class="player ${p.id === state.currentPlayerId ? 'current' : ''} ${p.id === state.viewerId ? 'me' : ''}" style="--player-color:${p.color}">
      <div class="player-head"><span class="avatar">${escape(p.name.charAt(0))}</span><span class="player-name">${escape(p.name)}</span><span class="score">${p.score} pt</span></div>
      <div class="tags">
        ${state.phase !== 'lobby' ? `<span class="tag ${p.alive ? '' : 'out'}">${p.alive ? '生存' : '脱落'}</span>` : ''}
        ${p.protected ? '<span class="tag safe">加護</span>' : ''}${!p.connected ? '<span class="tag offline">切断中</span>' : ''}
      </div>
      <div class="history">${p.played.length ? p.played.map((c) => `<div class="mini-card ${c.reason === 'magic' ? 'magic' : ''} ${c.reason === 'eliminated' ? 'revealed' : ''}"><strong>${c.value}</strong><span>${escape(c.name)}</span></div>`).join('') : '<span class="empty">公開札なし</span>'}</div>
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
  $('handArea').innerHTML = state.hand.map((c) => `<button class="card ${c.id === selectedCardId ? 'selected' : ''}" data-card-id="${c.id}" data-value="${c.value}" ${canPlay ? '' : 'disabled'}><div class="card-top"><span class="card-value">${c.value}</span><span class="card-name">${escape(c.name)}</span></div><div class="card-effect">${escape(c.effect)}</div></button>`).join('');
  document.querySelectorAll('[data-card-id]').forEach((el) => el.onclick = () => { selectedCardId = el.dataset.cardId; renderAction(); renderHand(); });
}

function renderLogs() {
  const fill = (el, logs, empty) => { el.innerHTML = logs.length ? logs.slice().reverse().map((l)=>`<div class="log-entry">${escape(l.text)}</div>`).join('') : `<div class="empty">${empty}</div>`; };
  fill($('publicLog'), state.publicLog, 'まだログはありません'); fill($('privateLog'), state.privateLog, '秘密の情報はここに表示されます');
}

function showSecretNotice(notice) {
  if (!notice || notice.id === lastSecretNoticeId || notice.type !== 'jester') return;
  lastSecretNoticeId = notice.id;
  $('secretTitle').textContent = notice.title;
  $('secretTarget').textContent = `${notice.targetName} の手札`;
  $('secretCard').innerHTML = `<div><strong>${notice.card.value}</strong><span>${escape(notice.card.name)}</span><p>${escape(notice.card.effect)}</p></div>`;
  if ($('secretDialog').open) $('secretDialog').close();
  $('secretDialog').showModal();
}

function renderRemainingCounts() {
  const seen = {};
  for (const player of state?.players || []) for (const card of player.played) seen[card.value] = (seen[card.value] || 0) + 1;
  $('remainingGrid').innerHTML = Object.entries(cardDefs).map(([value, def]) => {
    const remaining = Math.max(0, def.count - (seen[value] || 0));
    return `<div class="count-card"><div class="count-name">${value}・${escape(def.name)}</div><strong>${remaining}</strong><small>全${def.count}枚 / 公開${seen[value] || 0}枚</small></div>`;
  }).join('');
}

document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => {
  document.querySelectorAll('.tab').forEach((t)=>t.classList.toggle('active',t===tab));
  $('publicLog').classList.toggle('hidden',tab.dataset.tab!=='public'); $('privateLog').classList.toggle('hidden',tab.dataset.tab!=='private');
});
const rulesDialog = $('rulesDialog'); $('rulesButton').onclick = () => rulesDialog.showModal(); $('closeRules').onclick = () => rulesDialog.close();
const remainingDialog = $('remainingDialog'); $('remainingButton').onclick = () => { renderRemainingCounts(); remainingDialog.showModal(); }; $('closeRemaining').onclick = () => remainingDialog.close();
$('closeSecret').onclick = () => $('secretDialog').close();
fetch('/api/cards').then((r)=>r.json()).then((defs) => { cardDefs = defs; $('cardGuide').innerHTML = Object.entries(defs).map(([value,d])=>`<div class="guide-row"><strong>${value}・${escape(d.name)} ×${d.count}</strong><p>${escape(d.effect)}</p></div>`).join(''); });
renderColorPicker();

$('accessForm').onsubmit = async (event) => {
  event.preventDefault();
  const candidate = $('accessInput').value.trim();
  const result = await call('unlock', { accessKey: candidate });
  if (!result?.ok) { $('accessError').textContent = result?.error || 'アクセスできません。'; return; }
  accessKey = candidate;
  sessionStorage.setItem('royal-secret-access', accessKey);
  $('accessError').textContent = '';
  if (session?.roomCode && session?.sessionId) {
    const restored = await call('reconnectRoom', session);
    if (restored?.ok) return enterGame();
    session = null; localStorage.removeItem(storageKey);
  }
  showHome();
};

fetch('/api/access').then((r) => r.json()).then((config) => {
  accessRequired = Boolean(config.required);
  if (!accessRequired && socket.connected && !state) showHome();
  else if (accessRequired && !accessKey) showAccess();
}).catch(() => showAccess());
