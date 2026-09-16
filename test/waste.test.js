import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBarrel, submitReadings, dose, release, markAnomaly, rework,
  compatibility, tamperAttempt, withBarrelLock, idempotent, occupiedSlots,
  ApiError, PLAN_TTL_MS
} from "../src/waste.js";
import { migrate } from "../src/db.js";

function freshDb() {
  return migrate({ items: [], barrels: [], slots: [], idempotency: {} });
}
const R = (over = {}) => ({ ph: 7, cyanide: 0, heavyMetal: 0, oxidizer: 0, temperature: 25, volume: 100, ...over });
let clock = 1_700_000_000_000;
const now = () => clock;

function expectError(code, fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError && e.code === code, `期望 ${code}，实际 ${e.code || e.message}`);
    return;
  }
  throw new assert.AssertionError({ message: `应抛出 ${code} 但未抛出` });
}

// 依据方案每步的终点检查，自动给出合格的投后读数
function passingPost(step, prev) {
  const r = { ph: prev.ph, cyanide: prev.cyanide, heavyMetal: prev.heavyMetal, oxidizer: prev.oxidizer, temperature: Math.min(prev.temperature, 28) };
  for (const c of step.checks || []) {
    if (c.key === "ph") r.ph = c.op === ">=" ? Math.max(r.ph, c.limit) : c.op === "<=" ? Math.min(r.ph, c.limit) : (c.min + c.max) / 2;
    if (c.key === "cyanide") r.cyanide = 0.1;
    if (c.key === "heavyMetal") r.heavyMetal = 0.1;
    if (c.key === "oxidizer") r.oxidizer = 0.1;
    if (c.key === "temperature" && c.op === "<=") r.temperature = Math.min(r.temperature, c.limit);
  }
  return r;
}
async function runAllDoses(db, b, operator = "投药员甲", overrides = {}) {
  while (b.status === "待处置" || b.status === "处置中") {
    const i = b.doses.length;
    const step = b.plan.steps[i];
    const prev = b.doses.length ? b.doses[b.doses.length - 1].postReadings : b.readings[b.readings.length - 1];
    const post = { ...passingPost(step, prev), ...overrides };
    dose(db, b.id, { stepIndex: i, actualAmount: 10, operator, postReadings: post }, now());
    clock += 1000;
  }
  return b;
}

test("完整走通：建档→检测→投药→放行，放行后释放桶位", async () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-0620", sourceStep: "冲洗", operator: "甲", sourceItemCode: "CN-001" }, now());
  assert.equal(b.status, "待检测");
  assert.equal(occupiedSlots(db), 1);

  submitReadings(db, b.id, { ...R(), operator: "甲" }, now());
  assert.equal(b.status, "待处置");
  assert.ok(b.plan.steps.length >= 1);
  assert.match(b.plan.steps.at(-1).name, /静置/);

  await runAllDoses(db, b);
  assert.equal(b.status, "待复检");

  release(db, b.id, { releaser: "乙", waybillNo: "YD-20260916-01", carrier: "蓝天危废运输" }, now());
  assert.equal(b.status, "已放行");
  assert.equal(b.releasedBy, "乙");
  assert.equal(b.waybill.no, "YD-20260916-01");
  assert.equal(occupiedSlots(db), 0);
});

test("放行人与操作人相同 → 拒绝放行且不改变状态", async () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R(), operator: "甲" }, now());
  await runAllDoses(db, b, "甲");
  assert.equal(b.status, "待复检");
  await expectError("separation_required", () => {
    release(db, b.id, { releaser: "甲", waybillNo: "W1", carrier: "c" }, now());
    return Promise.resolve();
  });
  assert.equal(b.status, "待复检");
});

test("无承运单据或缺项 → 400", () => {
  const db = freshDb();
  expectError("missing_field", () => { createBarrel(db, { sourceStep: "冲洗", operator: "甲" }); return Promise.resolve(); });
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  expectError("missing_field", () => { submitReadings(db, b.id, { ph: 7, operator: "甲" }); return Promise.resolve(); });
  assert.equal(b.status, "待检测"); // 失败不推进、不留半批次
  assert.equal(b.readings.length, 0);
});

test("检测超温(≥40°C)立即冻结", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R({ temperature: 42 }), operator: "甲" }, now());
  assert.equal(b.status, "已冻结");
  assert.ok(b.freezeReasons.join("；").includes("超温"));
});

test("投药温升超限 → 冻结；该步记录留痕但不允许继续", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R(), operator: "甲" }, now());
  const step = b.plan.steps[0]; // settle，允许温升2
  expectError("temperature_spike", () => {
    dose(db, b.id, { stepIndex: 0, actualAmount: 0, operator: "甲", postReadings: { ...R({ temperature: 28 }) } }, now());
    return Promise.resolve();
  });
  assert.equal(b.status, "已冻结");
  assert.equal(b.doses.length, 1); // 留痕
  expectError("barrel_frozen", () => { dose(db, b.id, { stepIndex: 1 }, now()); return Promise.resolve(); });
});

test("投药终点不合格 → 冻结", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R(), operator: "甲" }, now());
  expectError("endpoint_failed", () => {
    dose(db, b.id, { stepIndex: 0, actualAmount: 0, operator: "甲", postReadings: { ...R({ ph: 4 }) } }, now());
    return Promise.resolve();
  });
  assert.equal(b.status, "已冻结");
});

test("方案超过24小时 → 投药即冻结过期", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R(), operator: "甲" }, now());
  clock += PLAN_TTL_MS + 1000;
  expectError("plan_expired", () => {
    dose(db, b.id, { stepIndex: 0, actualAmount: 0, operator: "甲", postReadings: R() }, now());
    return Promise.resolve();
  });
  assert.equal(b.status, "已冻结");
  assert.ok(b.freezeReasons.join("").includes("过期"));
});

test("放行复核终点不合格 → 冻结", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R(), operator: "甲" }, now());
  runAllDoses(db, b);
  b.doses[b.doses.length - 1].postReadings.cyanide = 9; // 篡改内存模拟异常终点
  expectError("release_endpoint_failed", () => {
    release(db, b.id, { releaser: "乙", waybillNo: "W1", carrier: "c" }, now());
    return Promise.resolve();
  });
  assert.equal(b.status, "已冻结");
});

test("记录改动 → 冻结且拒绝", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  expectError("record_immutable", () => { tamperAttempt(db, b.id, {}); return Promise.resolve(); });
  assert.equal(b.status, "已冻结");
  assert.ok(b.freezeReasons.join("").includes("记录改动"));
});

test("异常报告冻结 → 返工另起批次并保留关联，桶位守恒", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-0620", sourceStep: "冲洗", operator: "甲", sourceItemCode: "CN-001" }, now());
  markAnomaly(db, b.id, { reason: "发现悬浮物", by: "丙" }, now());
  assert.equal(b.status, "已冻结");
  const slotsBefore = occupiedSlots(db);
  const nb = rework(db, b.id, { reason: "压滤后重做", operator: "甲" }, now());
  assert.notEqual(nb.id, b.id);
  assert.equal(b.status, "已返工");
  assert.equal(nb.status, "待检测");
  assert.equal(nb.parentBarrelId, b.id);
  assert.equal(b.reworkBarrelId, nb.id);
  assert.equal(nb.sourceBatch, "B-0620"); // 来源关联保留
  assert.equal(occupiedSlots(db), slotsBefore); // 旧桶释放、新桶占用，桶位守恒
});

test("返工新批次必须重新检测，不能直接放行", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  markAnomaly(db, b.id, { reason: "x", by: "丙" }, now());
  const nb = rework(db, b.id, { reason: "y", operator: "甲" }, now());
  expectError("invalid_status", () => {
    release(db, nb.id, { releaser: "乙", waybillNo: "W", carrier: "c" }, now());
    return Promise.resolve();
  });
});

test("含氰废液方案：先调碱→次氯酸钠破氰→…→静置，顺序明确", () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R({ ph: 5.5, cyanide: 20, heavyMetal: 5, oxidizer: 4, temperature: 38 }), operator: "甲" }, now());
  const codes = b.plan.steps.map(s => s.code);
  assert.deepEqual(codes[0], "cool");
  assert.ok(codes.indexOf("cn-alkali") < codes.indexOf("cn-primary"));
  assert.ok(codes.indexOf("cn-primary") < codes.indexOf("cn-secondary"));
  assert.ok(codes.indexOf("cn-secondary") < codes.indexOf("metal-lime"));
  assert.ok(codes.indexOf("metal-lime") < codes.indexOf("ox-quench"));
  assert.equal(codes.at(-1), "settle");
  for (const s of b.plan.steps) assert.ok(s.amount && s.orderNote && (s.maxRise !== undefined));

  runAllDoses(db, b);
  assert.equal(b.status, "待复检");
  release(db, b.id, { releaser: "乙", waybillNo: "W-9", carrier: "蓝天危废" }, now());
  assert.equal(b.status, "已放行");
});

test("配伍检查：冻结桶/已放行桶不得参与", () => {
  const db = freshDb();
  const a = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  const c = createBarrel(db, { sourceBatch: "B-2", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, a.id, { ...R(), operator: "甲" }, now());
  submitReadings(db, c.id, { ...R(), operator: "甲" }, now());
  markAnomaly(db, a.id, { reason: "x", by: "丙" }, now());
  expectError("barrel_frozen", () => { compatibility(db, [a.id, c.id]); return Promise.resolve(); });
});

test("幂等：同一键重复提交只建档一次，回放原结果", async () => {
  const db = freshDb();
  const key = "idem-create-1";
  const r1 = await idempotent(db, key, async () => ({ status: 201, body: createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now()) }));
  const r2 = await idempotent(db, key, async () => ({ status: 201, body: createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now()) }));
  assert.equal(r1.replay, false);
  assert.equal(r2.replay, true);
  assert.equal(r1.body.id, r2.body.id);
  assert.equal(db.barrels.length, 1);
});

test("并发投药同一步：只成功一次，失败不留半批次", async () => {
  const db = freshDb();
  const b = createBarrel(db, { sourceBatch: "B-1", sourceStep: "冲洗", operator: "甲" }, now());
  submitReadings(db, b.id, { ...R(), operator: "甲" }, now());
  const input = { stepIndex: 0, actualAmount: 0, operator: "甲", postReadings: R() };
  const [r1, r2] = await Promise.allSettled([
    withBarrelLock(b.id, async () => dose(db, b.id, input, now())),
    withBarrelLock(b.id, async () => dose(db, b.id, input, now()))
  ]);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r2.status, "rejected");
  assert.ok(["step_conflict", "invalid_status"].includes(r2.reason.code), `实际：${r2.reason.code}`);
  assert.equal(db.barrels[0].doses.length, 1);
  assert.equal(db.barrels[0].status, "待复检");
});

test("旧数据迁移：待检测、不自动放行、禁止参与配伍", () => {
  const db = migrate({ items: [], barrels: [{ id: "WB-OLD-1", sourceBatch: "B-old", sourceStep: "冲洗", operator: "老员工" }] });
  const old = db.barrels[0];
  assert.equal(old.status, "待检测");
  assert.equal(old.legacy, true);
  expectError("invalid_status", () => {
    release(db, old.id, { releaser: "乙", waybillNo: "W", carrier: "c" }, now());
    return Promise.resolve();
  });
});
