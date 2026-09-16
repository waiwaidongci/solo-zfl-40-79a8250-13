import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

let base, server, dir;
const R = (over = {}) => ({ ph: 7, cyanide: 0, heavyMetal: 0, oxidizer: 0, temperature: 25, volume: 100, ...over });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "wb-test-"));
  const dbPath = join(dir, "db.json");
  await new Promise(resolve => {
    server = createApp(dbPath);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const key = () => "k-" + Math.random().toString(36).slice(2);

async function makeBarrel(over = {}) {
  const r = await api("/api/waste/barrels", { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ sourceBatch: "B-0620", sourceStep: "冲洗", operator: "甲", ...over }) });
  assert.equal(r.status, 201);
  return r.data;
}
async function detect(id, over = {}) {
  const r = await api(`/api/waste/barrels/${id}/readings`, { method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ ...R(), operator: "甲", ...over }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
// 常规中性废液只有 settle 一步，投合格读数后即可待复检
async function oneStep(id, post = R(), idem = key()) {
  return api(`/api/waste/barrels/${id}/doses`, { method: "POST", headers: { "Idempotency-Key": idem }, body: JSON.stringify({ stepIndex: 0, actualAmount: 0, operator: "甲", postReadings: post }) });
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
