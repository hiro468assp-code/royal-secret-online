const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function animationClient() {
  const elements = new Map();
  const handlers = {};
  let finish;
  const element = () => {
    const classes = new Set();
    return { children: [], style: { setProperty() {} }, dataset: {}, attributes: {}, innerHTML: '',
      classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
        contains(c) { return classes.has(c); }, toggle(c, on) { on ? classes.add(c) : classes.delete(c); } },
      setAttribute(key, value) { this.attributes[key] = value; },
      replaceChildren() { this.innerHTML = ''; },
      getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 120 }; }
    };
  };
  const context = vm.createContext({
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement() { return { set textContent(v) { this.innerHTML = String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); } }; },
      querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; } }, io() { return { on(name, fn) { handlers[name] = fn; } }; },
    fetch() { return new Promise(() => {}); },
    window: { innerWidth: 1000, innerHeight: 700, addEventListener() {} },
    setTimeout(fn) { finish = fn; return 1; }, clearTimeout() { finish = null; }
  });
  const run = (code) => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'));
  run(`
    const actor = {id:'a', name:'<使用者>', color:'#4e79a7', played:[]};
    const target = {id:'b', name:'対象', color:'#e15b64', played:[]};
    const initial = {viewerId:'a', roundNumber:1, phase:'turn', players:[actor,target], publicLog:[]};
    const card = {id:'card',value:1,name:'兵士',effect:'予想',reason:'play',order:1};
    const resolved = {...initial, players:[{...actor,played:[card]},target], publicLog:[
      {id:1,text:'兵士の結果',targetEffect:{actorId:'a',targetId:'b',cardValue:1,guess:6}}
    ]};
    collectCardPlays(initial); state = initial;
  `);
  return { run, elements, handlers, finish() { assert.ok(finish); finish(); } };
}

test('対象演出は新しい効果だけを検出し、更新・再接続・新ラウンドで再生しない', () => {
  const client = animationClient();
  assert.equal(client.run('collectCardPlays(resolved).length'), 2);
  client.run('state = resolved');
  assert.equal(client.run('collectCardPlays(resolved).length'), 0);
  client.handlers.disconnect();
  assert.equal(client.run('collectCardPlays(resolved).length'), 0);
  assert.equal(client.run('collectCardPlays({...resolved,roundNumber:2}).length'), 0);
});

test('即座に効果を解決してもカード公開の後に対象演出を表示し、退出で消去する', () => {
  const client = animationClient();
  client.run('cardPlayQueue.push(...collectCardPlays(resolved)); state = resolved; showNextCardPlay()');
  assert.match(client.elements.get('cardPlayNotice').innerHTML, /兵士/);
  assert.equal(client.run('activeTargetEffect'), null);
  client.finish();
  assert.match(client.elements.get('targetEffectLayer').innerHTML, /&lt;使用者&gt;/);
  assert.match(client.elements.get('targetEffectLayer').innerHTML, /「6」を予想/);
  assert.equal(client.run('activeTargetEffect.target.id'), 'b');
  client.run('showHome()');
  assert.equal(client.elements.get('targetEffectLayer').classList.contains('hidden'), true);
  assert.equal(client.run('cardPlayQueue.length'), 0);
});

test('対象枠と矢印は現在のプレイヤー位置に追従し、終了時に消える', () => {
  const client = animationClient();
  client.run('cardPlayQueue.push(...collectCardPlays(resolved).filter(e => e.type === "target")); state = resolved; showNextCardPlay()');
  client.elements.get('players').children = [
    { getBoundingClientRect() { return {left:10,top:20,width:100,height:120}; } },
    { getBoundingClientRect() { return {left:200,top:20,width:100,height:120}; } }
  ];
  client.run('positionTargetEffect()');
  assert.equal(client.elements.get('targetEffectLine').attributes.x1, 60);
  assert.equal(client.elements.get('targetEffectLine').attributes.x2, 250);
  assert.equal(client.elements.get('targetRecipientFrame').style.left, '200px');
  client.elements.get('players').children[1].getBoundingClientRect = () => ({left:10,top:180,width:100,height:120});
  client.run('positionTargetEffect()');
  assert.equal(client.elements.get('targetEffectLine').attributes.y2, 240);
  client.finish();
  assert.equal(client.elements.get('targetEffectLayer').classList.contains('hidden'), true);
});
