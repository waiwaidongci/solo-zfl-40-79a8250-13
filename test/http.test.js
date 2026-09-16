import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

let base, server, dir, dbPath, reg, regBase, regPath;
const R = (over = {}) => ({ ph: 7, cyanide: 0, heavyMetal: 0, oxidizer: 0, temperature: 25, volume: 100, ...over });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "wb-test-"));
  dbPath = join(dir, "db.json");
  await new Promise(resolve => {
    server = createApp(dbPath);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // 回归组使用独立数据库，避免与主流程用例累积占满桶位（上限12）
  regPath = join(dir, `reg-${Math.random().toString(36).slice(2)}.json`);
  reg = createApp(regPath);
  await new Promise(resolve => reg.listen(0, "127.0.0.1", resolve));
  regBase = `http://127.0.0.1:${reg.address().port}`;
});
after(async () => {
  reg.closeAllConnections?.();
  await new Promise(r => reg.close(r));
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

// 针对同一数据文件再起一个服务，模拟进程重启
async function restartOn(path = dbPath) {
  const s = createApp(path);
  await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${s.address().port}`;
  const close = async () => { s.closeAllConnections?.(); await new Promise(r => s.close(r)); };
  return { s, base: b, close };
}

async function api(path, options = {}, root = base) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(root + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const key = () => "k-" + Math.random().toString(36).slice(2);

async function makeBarrel(over = {}, root = base) {
  const r = await api("/api/waste/barrels", { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ sourceBatch: "B-0620", sourceStep: "冲洗", operator: "甲", ...over }) }, root);
  assert.equal(r.status, 201);
  return r.data;
}
async function detect(id, over = {}, root = base) {
  const r = await api(`/api/waste/barrels/${id}/readings`, { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ ...R(), operator: "甲", ...over }) }, root);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
// 常规中性废液只有 settle 一步，投合格读数后即可待复检
async function oneStep(id, post = R(), idem = key(), root = base) {
  return api(`/api/waste/barrels/${id}/doses`, { method: "POST", headers: { "Idempotency-Key": idem }, body: JSON.stringify({ stepIndex: 0, actualAmount: 0, operator: "甲", postReadings: post }) }, root);
}

test("旧接口保持一致：底片建档/列表/动作/统计", async () => {
  const created = await api("/api/items", { method: "POST", body: JSON.stringify({ code: "CN-T1", chemicalBatch: "B-0620", status: "待曝光" }) });
  assert.equal(created.status, 201);
  const list = await api("/api/items");
  assert.ok(list.data.some(i => (i.code || i.id) === "CN-T1"));
  const id = created.data.id || "CN-T1";
  const acted = await api(`/api/items/${encodeURIComponent(id)}/action`, { method: "POST", body: JSON.stringify({ step: "冲洗", note: "接口兼容" }) });
  assert.equal(acted.status, 201);
  assert.equal(acted.data.status, "冲洗中");
  const stats = await api("/api/stats");
  assert.equal(stats.status, 200);
});

test("页面可访问", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /暗房废液/);
});

test("建档缺项 → 400 且不占桶位", async () => {
  const before = await api("/api/waste/barrels");
  const bad = await api("/api/waste/barrels", { method: "POST", body: JSON.stringify({ sourceStep: "冲洗" }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "missing_field");
  const after = await api("/api/waste/barrels");
  assert.equal(before.data.length, after.data.length);
});

test("建档→检测→投药→不同人凭单放行 全流程", async () => {
  const b = await makeBarrel();
  assert.equal(b.status, "待检测");
  const d = await detect(b.id);
  assert.equal(d.status, "待处置");
  assert.ok(d.plan.steps.length >= 1);
  const doseRes = await oneStep(b.id);
  assert.equal(doseRes.status, 201);
  assert.equal(doseRes.data.status, "待复检");

  const samePerson = await api(`/api/waste/barrels/${b.id}/release`, { method: "POST", body: JSON.stringify({ releaser: "甲", waybillNo: "W-1", carrier: "蓝天危废" }) });
  assert.equal(samePerson.status, 403);
  assert.equal(samePerson.data.error, "separation_required");

  const noWaybill = await api(`/api/waste/barrels/${b.id}/release`, { method: "POST", body: JSON.stringify({ releaser: "乙" }) });
  assert.equal(noWaybill.status, 400);

  const ok = await api(`/api/waste/barrels/${b.id}/release`, { method: "POST", body: JSON.stringify({ releaser: "乙", waybillNo: "YD-001", carrier: "蓝天危废" }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "已放行");
});

test("重复提交（同一幂等键）只成功一次，第二次为回放", async () => {
  const b = await makeBarrel();
  await detect(b.id);
  const k = key();
  const [r1, r2] = await Promise.all([oneStep(b.id, R(), k), oneStep(b.id, R(), k)]);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201); // 幂等回放原成功结果
  const fresh = await api("/api/waste/barrels");
  const saved = fresh.data.find(x => x.id === b.id);
  assert.equal(saved.doseCount, 1); // 没有产生半批次/重复步
  assert.equal(saved.status, "待复检");
});

test("并发投药（不同幂等键）只有一个成功，另一个冲突且不留半批次", async () => {
  const b = await makeBarrel();
  await detect(b.id);
  const [r1, r2] = await Promise.all([oneStep(b.id, R(), key()), oneStep(b.id, R(), key())]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [201, 409]);
  const winner = r1.status === 201 ? r1.data : r2.data;
  assert.equal(winner.doses.length, 1);
  assert.equal(winner.status, "待复检");
});

test("超温检测 → 冻结并返回原因；冻结桶拒绝继续操作", async () => {
  const b = await makeBarrel();
  const r = await detect(b.id, { temperature: 41 });
  assert.equal(r.status, "已冻结");
  const again = await api(`/api/waste/barrels/${b.id}/readings`, { method: "POST", body: JSON.stringify({ ...R(), operator: "甲" }) });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "barrel_frozen");
});

test("配伍冲突接口：含氰×酸性不混装；待检测桶被拒", async () => {
  const a = await makeBarrel({ sourceBatch: "B-CN" });
  const c = await makeBarrel({ sourceBatch: "B-AC" });
  await detect(a.id, { cyanide: 10 });
  await detect(c.id, { ph: 3 });
  const r = await api("/api/waste/compatibility", { method: "POST", body: JSON.stringify({ ids: [a.id, c.id] }) });
  assert.equal(r.status, 200);
  assert.equal(r.data.compatible, false);
  assert.ok(r.data.conflicts.length >= 1);

  const u = await makeBarrel();
  const ru = await api("/api/waste/compatibility", { method: "POST", body: JSON.stringify({ ids: [a.id, u.id] }) });
  assert.equal(ru.data.compatible, false);
  assert.deepEqual(ru.data.untested, [u.id]);
});

test("改动记录(PATCH) → 拒绝并冻结；返工另起批次保留关联", async () => {
  const b = await makeBarrel();
  const patch = await api(`/api/waste/barrels/${b.id}`, { method: "PATCH", body: JSON.stringify({ operator: "偷偷换人" }) });
  assert.equal(patch.status, 409);
  assert.equal(patch.data.error, "record_immutable");
  const frozen = (await api("/api/waste/barrels")).data.find(x => x.id === b.id);
  assert.equal(frozen.status, "已冻结");

  const rw = await api(`/api/waste/barrels/${b.id}/rework`, { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ reason: "纠正记录", operator: "甲" }) });
  assert.equal(rw.status, 201);
  assert.equal(rw.data.parentBarrelId, b.id);
  assert.equal(rw.data.status, "待检测");
  const old = (await api("/api/waste/barrels")).data.find(x => x.id === b.id);
  assert.equal(old.status, "已返工");
  assert.equal(old.reworkBarrelId, rw.data.id);
});

test("返工新批次旧数据不自动放行：须重新走完检测处置", async () => {
  const b = await makeBarrel();
  await api(`/api/waste/barrels/${b.id}/anomaly`, { method: "POST", body: JSON.stringify({ reason: "异味", by: "丙" }) });
  const rw = await api(`/api/waste/barrels/${b.id}/rework`, { method: "POST", body: JSON.stringify({ reason: "返工", operator: "甲" }) });
  const early = await api(`/api/waste/barrels/${rw.data.id}/release`, { method: "POST", body: JSON.stringify({ releaser: "乙", waybillNo: "W", carrier: "c" }) });
  assert.equal(early.status, 409);
  await detect(rw.data.id);
  await oneStep(rw.data.id);
  const ok = await api(`/api/waste/barrels/${rw.data.id}/release`, { method: "POST", body: JSON.stringify({ releaser: "乙", waybillNo: "YD-002", carrier: "蓝天危废" }) });
  assert.equal(ok.status, 200);
});

test("历史 JSON 文件中的旧废液数据迁移为待检测，绝不自动放行", async () => {
  const legacyPath = join(dir, `legacy-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(legacyPath, JSON.stringify({
    items: [],
    barrels: [{ id: "WB-LEGACY", sourceBatch: "B-OLD", sourceStep: "冲洗", operator: "老员工", doses: [], readings: [] }]
  }));
  await new Promise(resolve => {
    const s2 = createApp(legacyPath);
    s2.listen(0, "127.0.0.1", () => {
      const port2 = s2.address().port;
      (async () => {
        const r = await fetch(`http://127.0.0.1:${port2}/api/waste/barrels`).then(x => x.json());
        assert.equal(r[0].status, "待检测");
        assert.equal(r[0].legacy, true);
        const rel = await fetch(`http://127.0.0.1:${port2}/api/waste/barrels/WB-LEGACY/release`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ releaser: "乙", waybillNo: "W", carrier: "c" })
        }).then(x => x.json());
        assert.equal(rel.error, "invalid_status");
        s2.close(resolve);
      })();
    });
  });
});

// ---------- 回归：失败必须落盘完整冻结证据，桶不能继续操作（独立数据库 reg） ----------
test("回归：投药超温 → 报错说明冻结；随后查询为已冻结且含证据，不能继续操作", async () => {
  const b = await makeBarrel({}, regBase);
  await detect(b.id, { temperature: 30 }, regBase); // 常规方案仅 settle 一步，允许温升2/上限40
  const bad = await oneStep(b.id, { ...R(), temperature: 42 }, undefined, regBase);
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error, "over_temperature");
  assert.match(bad.data.detail, /冻结/);

  const saved = (await api("/api/waste/barrels", {}, regBase)).data.find(x => x.id === b.id);
  assert.equal(saved.status, "已冻结");
  assert.ok(saved.freezeReasons.length >= 1, "必须写入冻结原因");
  assert.match(saved.freezeReasons.join("；"), /超温/);
  assert.equal(saved.doseCount, 1, "冻结当步投药证据须保留");
  assert.ok(saved.events.some(e => e.type === "冻结"), "须有冻结事件");

  const again = await oneStep(b.id, { ...R(), temperature: 26 }, undefined, regBase);
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "barrel_frozen", "冻结桶不得继续投药");
});

test("回归：投药温升超限 → 持久化冻结证据", async () => {
  const b = await makeBarrel({}, regBase);
  await detect(b.id, { temperature: 25 }, regBase);
  const bad = await oneStep(b.id, { ...R(), temperature: 28 }, undefined, regBase); // 温升3 > settle允许2
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error, "temperature_spike");
  const saved = (await api("/api/waste/barrels", {}, regBase)).data.find(x => x.id === b.id);
  assert.equal(saved.status, "已冻结");
  assert.match(saved.freezeReasons.join("；"), /温升/);
  assert.equal(saved.doses[0].rise, 3); // 温升证据留痕
});

test("回归：投药终点不合格 → 持久化冻结证据", async () => {
  const b = await makeBarrel({}, regBase);
  await detect(b.id, { temperature: 25 }, regBase);
  const bad = await oneStep(b.id, { ...R(), ph: 4, temperature: 25 }, undefined, regBase);
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error, "endpoint_failed");
  const saved = (await api("/api/waste/barrels", {}, regBase)).data.find(x => x.id === b.id);
  assert.equal(saved.status, "已冻结");
  assert.match(saved.freezeReasons.join("；"), /终点异常/);
});

test("回归：方案过期 → 投药报错并冻结，证据落盘", async () => {
  const b = await makeBarrel({}, regBase);
  await detect(b.id, { temperature: 25 }, regBase);
  // 直接把数据文件里的方案时间回拨到25小时前，模拟重启/跨日后过期
  const db = JSON.parse(await readFile(regPath, "utf8"));
  const row = db.barrels.find(x => x.id === b.id);
  row.plan.generatedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await writeFile(regPath, JSON.stringify(db, null, 2));

  const bad = await oneStep(b.id, R(), undefined, regBase);
  assert.equal(bad.status, 409);
  assert.equal(bad.data.error, "plan_expired");
  const saved = (await api("/api/waste/barrels", {}, regBase)).data.find(x => x.id === b.id);
  assert.equal(saved.status, "已冻结");
  assert.match(saved.freezeReasons.join("；"), /过期/);
  assert.equal(saved.events.at(-1).type, "冻结");
});

test("回归：放行终点不合格 → 冻结证据落盘，不能再放行", async () => {
  const b = await makeBarrel({}, regBase);
  await detect(b.id, { temperature: 25 }, regBase);
  await oneStep(b.id, R(), undefined, regBase);
  // 回拨末次读数为超标，模拟复检发现终点不达标
  const db = JSON.parse(await readFile(regPath, "utf8"));
  const row = db.barrels.find(x => x.id === b.id);
  row.doses.at(-1).postReadings.cyanide = 9;
  await writeFile(regPath, JSON.stringify(db, null, 2));

  const bad = await api(`/api/waste/barrels/${b.id}/release`, {
    method: "POST", body: JSON.stringify({ releaser: "乙", waybillNo: "W", carrier: "c" })
  }, regBase);
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error, "release_endpoint_failed");
  const saved = (await api("/api/waste/barrels", {}, regBase)).data.find(x => x.id === b.id);
  assert.equal(saved.status, "已冻结");
  assert.match(saved.freezeReasons.join("；"), /终点不合格/);
});

// ---------- 回归：重启后续号，不与既有桶争用身份（独立干净数据库） ----------
test("回归：服务重启后新建桶从已有数据继续取唯一编号", async () => {
  const seqPath = join(dir, `seq-${Math.random().toString(36).slice(2)}.json`);
  const r1 = await restartOn(seqPath);
  let a, c;
  try {
    const post = body => fetch(`${r1.base}/api/waste/barrels`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify(body)
    });
    a = await (await post({ sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" })).json();
    c = await (await post({ sourceBatch: "B-2", sourceStep: "冲洗", operator: "甲" })).json();
    assert.notEqual(a.id, c.id);
    const before = (await (await fetch(`${r1.base}/api/waste/barrels`)).json()).map(x => x.id);
    assert.deepEqual(before.sort(), [a.id, c.id].sort());
  } finally {
    await r1.close(); // 模拟进程退出
  }

  // 用同一数据文件重启（进程内编号计数器已随之消失，只能靠存量数据续号）
  const r2 = await restartOn(seqPath);
  try {
    const created = await (await fetch(`${r2.base}/api/waste/barrels`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify({ sourceBatch: "B-R", sourceStep: "冲洗", operator: "甲" })
    })).json();

    assert.ok(![a.id, c.id].includes(created.id), "新编号不得与重启前任何桶重复");

    // 原编号不得因重启被改动
    const after = await (await fetch(`${r2.base}/api/waste/barrels`)).json();
    const ids = after.map(x => x.id);
    assert.ok(ids.includes(a.id) && ids.includes(c.id), "旧桶身份保持不变");

    // 重启后连续再建一个，仍续号不撞车
    const another = await (await fetch(`${r2.base}/api/waste/barrels`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify({ sourceBatch: "B-R2", sourceStep: "冲洗", operator: "甲" })
    })).json();
    assert.notEqual(another.id, created.id);
    const all = (await (await fetch(`${r2.base}/api/waste/barrels`)).json()).map(x => x.id);
    assert.equal(new Set(all).size, all.length, "全部桶编号唯一");
    // 同一身份绝不能被两条记录争用
    assert.equal(all.filter(x => x === created.id).length, 1);
  } finally {
    await r2.close();
  }
});

test("回归：迁移不改变原有（含标准/非标准）桶编号，且新桶编号不与其冲突", async () => {
  const legacyPath = join(dir, `legacy-id-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(legacyPath, JSON.stringify({
    items: [],
    barrels: [
      { id: "WB-20260915-007", sourceBatch: "B-OLD1", sourceStep: "冲洗", operator: "老员工", doses: [], readings: [] },
      { id: "WB-CUSTOM-NO-SEQ", sourceBatch: "B-OLD2", sourceStep: "涂布", operator: "老员工", doses: [], readings: [] }
    ]
  }));
  const r2 = await restartOn(legacyPath);
  try {
    const list = await fetch(`${r2.base}/api/waste/barrels`).then(x => x.json());
    const ids = list.map(x => x.id).sort();
    assert.deepEqual(ids, ["WB-20260915-007", "WB-CUSTOM-NO-SEQ"], "迁移不得改编号");
    assert.ok(list.every(x => x.status === "待检测" && x.legacy === true));

    const created = await fetch(`${r2.base}/api/waste/barrels`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceBatch: "B-N", sourceStep: "冲洗", operator: "甲" })
    }).then(x => x.json());
    assert.ok(!["WB-20260915-007", "WB-CUSTOM-NO-SEQ"].includes(created.id), "新编号避开旧编号");
    assert.match(created.id, /^WB-\d{8}-008$/, "流水号须从存量最大值007续到008");

    // 再建一个仍唯一
    const again = await fetch(`${r2.base}/api/waste/barrels`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceBatch: "B-N2", sourceStep: "冲洗", operator: "甲" })
    }).then(x => x.json());
    assert.match(again.id, /^WB-\d{8}-009$/);
  } finally {
    await r2.close();
  }
});
