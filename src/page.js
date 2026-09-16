export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>古法蓝晒底片整理室 · 暗房废液</title>
<style>
  :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d1d; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
  header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
  h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:15px; }
  nav { display:flex; gap:8px; padding:12px 28px 0; flex-wrap:wrap; }
  nav button { background:#e4e9e0; color:var(--ink); border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; padding:9px 16px; font-weight:700; cursor:pointer; }
  nav button.active { background:var(--panel); color:var(--accent); }
  main { padding:20px 28px; } .tab { display:none; } .tab.active { display:block; }
  form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
  label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
  button.act { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; }
  button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:.45; cursor:not-allowed; }
  .layout { display:grid; grid-template-columns:360px 1fr; gap:18px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(105px,1fr)); gap:9px; margin-bottom:13px; }
  .stat strong { display:block; font-size:22px; } .stat span { font-size:12px; color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:11px; }
  .card { display:grid; gap:6px; } .meta { color:var(--muted); font-size:12.5px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; justify-self:start; }
  .pill.待检测 { background:#eef0ea; } .pill.待处置 { background:#fdf6e0; color:var(--hold); }
  .pill.处置中 { background:#e7eef9; color:#2c4f7c; } .pill.待复检 { background:#e6f3ea; color:var(--accent); }
  .pill.已放行 { background:#dfeede; color:#35602c; } .pill.已冻结 { background:#f7e4df; color:var(--warn); }
  .pill.已返工 { background:#ececec; color:#555; }
  .warn { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:end; } .row > div { flex:1; min-width:110px; }
  .plan-step { border-left:3px solid var(--line); padding:7px 10px; margin:6px 0; background:#fafbF8; border-radius:0 6px 6px 0; }
  .plan-step.next { border-left-color:var(--accent); background:#f2f7ee; }
  .plan-step.done { border-left-color:#9bb18f; opacity:.75; }
  .events { max-height:120px; overflow:auto; border-top:1px solid var(--line); padding-top:6px; }
  .msg { position:fixed; right:18px; bottom:18px; max-width:380px; display:grid; gap:8px; z-index:9; }
  .toast { background:#2d332b; color:#fff; padding:10px 14px; border-radius:8px; font-size:13px; }
  .toast.err { background:var(--warn); }
  table { border-collapse:collapse; width:100%; font-size:13px; } td,th { border:1px solid var(--line); padding:6px 8px; text-align:left; }
  @media (max-width:900px){ .layout{grid-template-columns:1fr;} header{display:block;padding:14px 16px;} nav{padding:10px 12px 0;} main{padding:14px;} }
</style>
</head>
<body>
<header><div><h1>古法蓝晒底片整理室</h1><div class="meta">底片工序 · 暗房废液中和与转运放行</div></div><button class="act" id="reload">刷新</button></header>
<nav>
  <button data-tab="neg" class="active">底片工序</button>
  <button data-tab="create">① 废液建档</button>
  <button data-tab="compat">② 配伍方案</button>
  <button data-tab="treat">③ 处置投药</button>
  <button data-tab="release">④ 转运放行</button>
  <button data-tab="anomaly">⑤ 异常恢复</button>
</nav>
<main>
  <section class="tab active" id="tab-neg">
    <div class="layout">
      <div>
        <form class="panel" id="negCreateForm"><h2>新增底片</h2><div id="negFields"></div><label>初始状态</label><select name="status"><option>待曝光</option><option>冲洗中</option><option>待入盒</option><option>已交付</option></select><p><button class="act">保存底片</button></p></form>
        <form class="panel" id="negActionForm" style="margin-top:12px"><h2>记录工艺步骤</h2><label>选择底片</label><select name="id" id="negSelect"></select><div id="negExtra"></div><p><button class="act">提交记录</button></p></form>
      </div>
      <div>
        <div class="stats" id="negStats"></div>
        <div class="panel"><h2>底片与药液批次记录</h2><div class="grid" id="negCards"></div></div>
      </div>
    </div>
  </section>

  <section class="tab" id="tab-create">
    <div class="layout">
      <form class="panel" id="createForm">
        <h2>废液桶建档</h2>
        <p class="meta">废液桶关联来源药液批次与工序；旧数据须检测后方可处置，不自动放行。</p>
        <label>来源药液批次 *</label><input name="sourceBatch" placeholder="如 B-0620" required>
        <label>来源工序 *</label><select name="sourceStep"><option>涂布</option><option>曝光</option><option>冲洗</option><option>定影清洗</option><option>其他</option></select>
        <label>关联底片编号（可选）</label><input name="sourceItemCode" placeholder="如 CN-001">
        <label>建档操作员 *</label><input name="operator" required>
        <p><button class="act">建档并占用桶位</button></p>
        <div class="meta">桶位上限 <b id="slotInfo"></b></div>
      </form>
      <div class="panel">
        <h2>待检测桶（录入酸碱度/氰化物/重金属/氧化剂/温度/体积）</h2>
        <div class="grid" id="createCards"></div>
      </div>
    </div>
  </section>

  <section class="tab" id="tab-compat">
    <div class="panel">
      <h2>配伍（相容性）检查</h2>
      <p class="meta">按酸碱度、氰化物、重金属、氧化剂和温度判定；冲突不混装。待检测/超温/冻结桶不得参与。</p>
      <div class="row" id="compatPick"></div>
      <p><button class="act" id="compatBtn">检查配伍</button></p>
      <div id="compatResult"></div>
    </div>
    <div class="panel" style="margin-top:14px"><h2>已生成配伍处置方案（24小时有效）</h2><div class="grid" id="compatCards"></div></div>
  </section>

  <section class="tab" id="tab-treat">
    <div class="panel"><h2>处置投药</h2><p class="meta">按方案顺序逐步执行；每步记录实际用量、投后读数与温升，只能成功一次。</p><div class="grid" id="treatCards"></div></div>
  </section>

  <section class="tab" id="tab-release">
    <div class="panel"><h2>转运放行</h2><p class="meta">终点 pH6~9、氰&lt;0.5、重金属&lt;0.5、氧化剂&lt;1.0mg/L、温度≤30°C；放行人与操作人须不同，并凭承运单据放行。</p><div class="grid" id="releaseCards"></div></div>
  </section>

  <section class="tab" id="tab-anomaly">
    <div class="panel"><h2>异常冻结与返工恢复</h2><p class="meta">缺项、超温、终点异常、方案过期、记录改动即冻结。返工另起批次并保留关联；冻结桶继续占用桶位。</p><div class="grid" id="anomalyCards"></div></div>
    <div class="panel" style="margin-top:14px"><h2>已放行 / 已返工台账</h2><div class="grid" id="doneCards"></div></div>
  </section>
</main>
<div class="msg" id="toasts"></div>

<script>
const stages = ["待曝光","冲洗中","待入盒","已交付"];
const negFields = [["code","底片编号"],["plateSize","玻璃板尺寸"],["chemicalBatch","药液批次"],["exposure","曝光时间"],["waterSource","冲洗水源"],["box","存放盒位"]];
const negExtra = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];
let items = [], barrels = [];
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error ? data.error + (data.detail ? "：" + data.detail : "") : "请求失败"); e.payload = data; throw e; }
  return data;
}
function toast(msg, isErr) { const t = document.createElement("div"); t.className = "toast" + (isErr ? " err" : ""); t.textContent = msg; $("#toasts").appendChild(t); setTimeout(() => t.remove(), 5200); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function idemKey() { return "ui-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9); }

$$("nav button").forEach(btn => btn.onclick = () => {
  $$("nav button").forEach(b => b.classList.remove("active")); btn.classList.add("active");
  $$(".tab").forEach(t => t.classList.remove("active")); $("#tab-" + btn.dataset.tab).classList.add("active");
});

/* ---------- 底片（原有功能，接口不变） ---------- */
function renderNegForms() {
  $("#negFields").innerHTML = negFields.map(([k,l]) => '<label>'+l+'</label><input name="'+k+'" '+(k==="code"?"required":"")+'>').join("");
  $("#negExtra").innerHTML = negExtra.map(([k,l]) => '<label>'+l+'</label><input name="'+k+'">').join("");
}
function cardNeg(item) {
  const main = negFields.slice(0,4).map(([k,l]) => '<div><b>'+l+'</b> '+esc(item[k])+'</div>').join("");
  const logs = (item.logs||[]).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join("");
  const id = item.id || item.code;
  return '<article class="card"><h3>'+esc(item.code||item.id)+'</h3><span class="pill '+esc(item.status)+'">'+esc(item.status)+'</span>'+main
    + '<label>状态</label><select data-negstatus="'+esc(id)+'">'+stages.map(s=>'<option '+(s===item.status?"selected":"")+'>'+s+"</option>").join("")+"</select>"
    + '<div class="events meta">'+(logs||"暂无记录")+'</div></article>';
}
function renderNeg() {
  $("#negSelect").innerHTML = items.map(i => '<option value="'+esc(i.id||i.code)+'">'+esc(i.code)+'</option>').join("");
  $("#negStats").innerHTML = stages.map(s => '<div class="stat"><span>'+s+'</span><strong>'+items.filter(i=>i.status===s).length+'</strong></div>').join("");
  $("#negCards").innerHTML = items.map(cardNeg).join("");
  $$("[data-negstatus]").forEach(sel => sel.onchange = async () => { try { await api("/api/items/"+encodeURIComponent(sel.dataset.negstatus), { method:"PATCH", body: JSON.stringify({ status: sel.value }) }); await loadAll(); } catch(e){ toast(e.message,true);} });
}
$("#negCreateForm").onsubmit = async ev => { ev.preventDefault(); try { await api("/api/items", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(ev.target).entries())) }); ev.target.reset(); toast("底片已建档"); await loadAll(); } catch(e){ toast(e.message,true);} };
$("#negActionForm").onsubmit = async ev => { ev.preventDefault(); const f = ev.target; try { await api("/api/items/"+encodeURIComponent(f.id.value)+"/action", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(f).entries())) }); f.reset(); toast("工艺记录已提交"); await loadAll(); } catch(e){ toast(e.message,true);} };

/* ---------- 通用桶卡片 ---------- */
function readingLine(r) {
  if (!r) return '<span class="warn">旧数据待检测</span>';
  return \`pH \${r.ph} · 氰 \${r.cyanide} · 重金属 \${r.heavyMetal} · 氧化剂 \${r.oxidizer} mg/L · \${r.temperature}°C · \${r.volume}L\`;
}
function eventsBlock(b) {
  return '<div class="events meta">' + (b.events||[]).slice(-6).map(e => esc(e.at.slice(0,16).replace("T"," "))+" "+e.type+" "+e.detail).join("<br>") + "</div>";
}
function baseCard(b, body) {
  const fr = (b.freezeReasons||[]);
  return '<article class="card"><h3>'+esc(b.id)+'</h3><span class="pill '+esc(b.status)+'">'+esc(b.status)+(b.legacy?"（旧）":"")+'</span>'
    + '<div class="meta">来源：'+esc(b.sourceBatch)+' / '+esc(b.sourceStep)+(b.sourceItemCode?" / "+esc(b.sourceItemCode):"")+'</div>'
    + '<div class="meta">建档：'+esc(b.operator)+(b.parentBarrelId?' · 返工自 <b>'+esc(b.parentBarrelId)+'</b>':"")+'</div>'
    + '<div class="meta">末次检测：'+readingLine(b.latestReadings)+'</div>'
    + (fr.length ? '<div class="warn">冻结：'+esc(fr.join("；"))+'</div>' : "")
    + body + eventsBlock(b) + "</article>";
}

/* ① 建档 + 检测录入 */
function renderCreate() {
  const used = barrels.filter(b => b.status!=="已放行" && b.status!=="已返工").length;
  $("#slotInfo").textContent = used + " / 12";
  const pending = barrels.filter(b => b.status==="待检测");
  $("#createCards").innerHTML = pending.length ? pending.map(b => baseCard(b,
    '<div class="row"><div><label>pH *</label><input type="number" step="0.1" id="r-ph-'+b.id+'"></div>'
    + '<div><label>氰化物 mg/L *</label><input type="number" step="0.01" id="r-cn-'+b.id+'"></div>'
    + '<div><label>重金属 mg/L *</label><input type="number" step="0.01" id="r-hm-'+b.id+'"></div></div>'
    + '<div class="row"><div><label>氧化剂 mg/L *</label><input type="number" step="0.01" id="r-ox-'+b.id+'"></div>'
    + '<div><label>温度 °C *</label><input type="number" step="0.1" id="r-tp-'+b.id+'"></div>'
    + '<div><label>体积 L *</label><input type="number" step="0.1" id="r-vo-'+b.id+'"></div></div>'
    + '<label>检测操作员 *</label><input id="r-op-'+b.id+'">'
    + '<p><button class="act" data-readings="'+esc(b.id)+'">提交检测并生成方案</button></p>'
  )).join("") : '<p class="meta">暂无待检测桶。</p>';
  $$("[data-readings]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.readings;
    const get = k => $("#r-"+k+"-"+id).value;
    try {
      await api("/api/waste/barrels/"+encodeURIComponent(id)+"/readings", {
        method:"POST", headers:{ "Idempotency-Key": idemKey() },
        body: JSON.stringify({ ph:get("ph"), cyanide:get("cn"), heavyMetal:get("hm"), oxidizer:get("ox"), temperature:get("tp"), volume:get("vo"), operator:get("op") })
      });
      toast("检测已记录，配伍处置方案已生成（24小时有效）"); await loadAll();
    } catch(e){ toast(e.message,true); await loadAll(); }
  });
}
$("#createForm").onsubmit = async ev => { ev.preventDefault();
  try { await api("/api/waste/barrels", { method:"POST", headers:{ "Idempotency-Key": idemKey() }, body: JSON.stringify(Object.fromEntries(new FormData(ev.target).entries())) }); ev.target.reset(); toast("废液桶已建档并占用桶位"); await loadAll(); }
  catch(e){ toast(e.message,true); }
};

/* ② 配伍 */
function planHtml(b) {
  if (!b.plan) return "";
  const done = b.doseCount;
  return b.plan.steps.map((s,i) =>
    '<div class="plan-step '+(i<done?"done":(i===done&&b.status==="处置中"||b.status==="待处置"?"next":""))+'">'
    + '<b>'+i+'. '+esc(s.name)+'</b> <span class="meta">'+esc(s.reagent)+'</span><br>'
    + '<span class="meta">用量：'+esc(s.amount)+(s.formula?"（"+esc(s.formula)+"）":"")+'</span><br>'
    + '<span class="meta">顺序：'+esc(s.orderNote)+'</span>'
    + (s.checks.length ? '<br><span class="meta">终点：'+s.checks.map(c=>esc(c.label)).join("，")+'</span>' : "")
    + '</div>').join("");
}
function renderCompat() {
  const choices = barrels.filter(b => ["待处置","处置中","待复检"].includes(b.status));
  $("#compatPick").innerHTML = choices.map(b =>
    '<div><label><input type="checkbox" style="width:auto" value="'+esc(b.id)+'"> '+esc(b.id)+'</label></div>').join("")
    || '<span class="meta">暂无可检查的桶（须先完成检测）。</span>';
  const planned = barrels.filter(b => b.plan);
  $("#compatCards").innerHTML = planned.map(b => baseCard(b, '<div class="meta">方案'+b.planStepCount+'步，已投 '+b.doseCount+' 步；'+(b.planExpired?'<span class="warn">方案已过期</span>':'<span class="ok">方案有效</span>')+'</div>'+planHtml(b))).join("") || '<p class="meta">暂无方案。</p>';
}
$("#compatBtn").onclick = async () => {
  const ids = $$('#compatPick input:checked').map(c => c.value);
  if (ids.length < 2) return toast("至少勾选两个桶", true);
  try {
    const r = await api("/api/waste/compatibility", { method:"POST", body: JSON.stringify({ ids }) });
    $("#compatResult").innerHTML = r.compatible
      ? '<p class="ok">✔ '+esc(r.message)+'，可同车转运（仍须各自处置合格后放行）。</p>'
      : '<p class="warn">✘ '+esc(r.message)+'</p>' + (r.untested?.length ? '<p class="warn">缺检测：'+r.untested.map(esc).join("、")+'（旧数据待检测，不得自动放行）</p>' : "")
        + '<table><tr><th>A</th><th>B</th><th>冲突</th><th>原因</th></tr>'+r.conflicts.map(c=>"<tr><td>"+esc(c.a)+"</td><td>"+esc(c.b)+"</td><td>"+esc(c.tagA)+" × "+esc(c.tagB)+"</td><td>"+esc(c.reason)+"</td></tr>").join("")+"</table>";
  } catch(e){ toast(e.message,true); }
};

/* ③ 处置投药 */
function renderTreat() {
  const list = barrels.filter(b => ["待处置","处置中"].includes(b.status));
  $("#treatCards").innerHTML = list.map(b => {
    const done = b.doses.length; const step = b.plan.steps[done];
    if (b.planExpired) return baseCard(b, '<p class="warn">方案已过期，请在“异常恢复”中返工另起批次。</p>');
    return baseCard(b, '<div>'+planHtml(b)+'</div>'
      + (step ? '<h3>执行第 '+done+' 步：'+esc(step.name)+'</h3>'
        + '<label>实际用量（'+(step.code==="settle"?"无":"g")+'）*</label><input type="number" step="any" id="d-am-'+b.id+'" value="'+(step.code==="settle"?"0":"")+'">'
        + '<div class="row"><div><label>投后pH*</label><input type="number" step="0.1" id="d-ph-'+b.id+'"></div><div><label>氰*</label><input type="number" step="0.01" id="d-cn-'+b.id+'"></div><div><label>重金属*</label><input type="number" step="0.01" id="d-hm-'+b.id+'"></div><div><label>氧化剂*</label><input type="number" step="0.01" id="d-ox-'+b.id+'"></div><div><label>温度°C*</label><input type="number" step="0.1" id="d-tp-'+b.id+'"></div></div>'
        + '<label>投药操作员 *</label><input id="d-op-'+b.id+'">'
        + '<p><button class="act" data-dose="'+esc(b.id)+'">提交本步投药（仅此一次）</button></p>' : ""));
  }).join("") || '<p class="meta">暂无待处置桶。</p>';
  $$("[data-dose]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.dose, get = k => $("#d-"+k+"-"+id).value;
    try {
      await api("/api/waste/barrels/"+encodeURIComponent(id)+"/doses", { method:"POST", headers:{ "Idempotency-Key": idemKey() },
        body: JSON.stringify({ stepIndex: barrels.find(b=>b.id===id).doseCount, actualAmount:get("am"), operator:get("op"),
          postReadings:{ ph:get("ph"), cyanide:get("cn"), heavyMetal:get("hm"), oxidizer:get("ox"), temperature:get("tp") } }) });
      toast("投药记录成功，进入下一步"); await loadAll();
    } catch(e){ toast(e.message,true); await loadAll(); }
  });
}

/* ④ 放行 */
function renderRelease() {
  const list = barrels.filter(b => b.status==="待复检");
  $("#releaseCards").innerHTML = list.map(b => baseCard(b,
    '<div class="meta">末次投后：'+readingLine(b.doses[b.doses.length-1].postReadings)+'，温升 '+b.doses[b.doses.length-1].rise+'°C</div>'
    + '<div class="row"><div><label>放行人 *（须不同于操作人）</label><input id="rl-by-'+b.id+'"></div><div><label>承运单据号 *</label><input id="rl-no-'+b.id+'"></div><div><label>承运单位 *</label><input id="rl-ca-'+b.id+'"></div></div>'
    + '<p><button class="act" data-release="'+esc(b.id)+'">凭承运单据放行</button> <button class="danger" data-tamper="'+esc(b.id)+'">尝试改动旧记录（演示冻结）</button></p>'
  )).join("") || '<p class="meta">暂无待放行桶。</p>';
  $$("[data-release]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.dose || btn.dataset.release, get = k => $("#rl-"+k+"-"+id).value;
    try { await api("/api/waste/barrels/"+encodeURIComponent(id)+"/release", { method:"POST", headers:{ "Idempotency-Key": idemKey() },
      body: JSON.stringify({ releaser:get("by"), waybillNo:get("no"), carrier:get("ca") }) });
      toast("已放行，桶位释放，承运单据已登记"); await loadAll();
    } catch(e){ toast(e.message,true); await loadAll(); }
  });
  $$("[data-tamper]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.tamper;
    try { await api("/api/waste/barrels/"+encodeURIComponent(id), { method:"PATCH", body: JSON.stringify({ hack:true }) }); }
    catch(e){ toast("改动被拒绝且批次已冻结：" + e.message, true); await loadAll(); }
  });
}

/* ⑤ 异常恢复 */
function renderAnomaly() {
  const list = barrels.filter(b => ["已冻结","待检测","待处置","处置中","待复检"].includes(b.status));
  $("#anomalyCards").innerHTML = list.map(b => baseCard(b,
    '<div class="row"><div><label>异常报告原因（手工冻结）</label><input id="an-rs-'+b.id+'"></div><div><label>报告人</label><input id="an-by-'+b.id+'"></div></div>'
    + '<p>'+(b.status!=="已冻结"?'<button class="danger" data-anom="'+esc(b.id)+'">报告异常并冻结</button> ':'')
    + (b.status==="已冻结"
      ? '<div class="row" style="margin-top:6px"><div><label>返工原因 *</label><input id="rw-rs-'+b.id+'"></div><div><label>返工操作员 *</label><input id="rw-op-'+b.id+'"></div></div><button class="act" data-rework="'+esc(b.id)+'">返工：另起批次（保留关联）</button>' : "")
    + '</p>' + (b.reworkBarrelId ? '<div class="ok">已转入新批次 '+esc(b.reworkBarrelId)+'</div>' : "")
  )).join("") || '<p class="meta">暂无处理中桶。</p>';
  $$("[data-anom]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.anom;
    try { await api("/api/waste/barrels/"+encodeURIComponent(id)+"/anomaly", { method:"POST", headers:{"Idempotency-Key":idemKey()}, body: JSON.stringify({ reason:$("#an-rs-"+id).value || "未写明", by:$("#an-by-"+id).value || "未署名" }) }); toast("已冻结"); await loadAll(); }
    catch(e){ toast(e.message,true); }
  });
  $$("[data-rework]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.rework;
    try { const nb = await api("/api/waste/barrels/"+encodeURIComponent(id)+"/rework", { method:"POST", headers:{"Idempotency-Key":idemKey()}, body: JSON.stringify({ reason:$("#rw-rs-"+id).value, operator:$("#rw-op-"+id).value }) });
      toast("返工新批次 "+nb.id+" 已建档，原桶关联保留"); await loadAll();
    } catch(e){ toast(e.message,true); }
  });
  $("#doneCards").innerHTML = barrels.filter(b => ["已放行","已返工"].includes(b.status)).map(b => baseCard(b,
    b.status==="已放行" ? '<div class="ok">承运单 '+esc(b.waybill.no)+' / '+esc(b.waybill.carrier)+'，放行人 '+esc(b.releasedBy)+'</div>'
                      : '<div class="meta">已返工 → '+esc(b.reworkBarrelId||"")+'</div>'
  )).join("") || '<p class="meta">暂无台账。</p>';
}

async function loadAll() {
  [items, barrels] = await Promise.all([api("/api/items"), api("/api/waste/barrels")]);
  renderNeg(); renderCreate(); renderCompat(); renderTreat(); renderRelease(); renderAnomaly();
}
$("#reload").onclick = loadAll;
renderNegForms(); loadAll().catch(e => toast(e.message,true));
</script>
</body>
</html>`;
}
