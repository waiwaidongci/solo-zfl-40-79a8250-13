// 暗房废液中和与转运放行：领域服务。
// 状态机：待检测 → 待处置 → 处置中 → 待复检 → 已放行
// 任何缺项/超温/异常/过期/改动 → 已冻结；返工另起新批次并保留关联（原桶 → 已返工）。

import { checkCompatibility } from "./compat.js";

export const STATUSES = ["待检测", "待处置", "处置中", "待复检", "已冻结", "已放行", "已返工"];
export const SLOT_LIMIT = 12;
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000; // 配伍处置方案有效期 24h
export const TEMP_FREEZE = 40; // °C，任何读数到此立即冻结
export const TEMP_COOL = 35;   // °C，以上须先冷却，且按配伍规则视为高温禁混
export const TEMP_RELEASE = 30;// °C，放行温度上限
export const MAX_RISE_DEFAULT = 10; // °C，单步允许温升

// 放行终点
export const LIMITS = { phMin: 6, phMax: 9, cyanide: 0.5, heavyMetal: 0.5, oxidizer: 1.0 };

export class ApiError extends Error {
  constructor(status, code, detail) {
    super(code + (detail ? `: ${detail}` : ""));
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

let seq = 0;
function wbId(now) {
  const d = new Date(now);
  const p = n => String(n).padStart(2, "0");
  seq += 1;
  return `WB-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(seq).padStart(3, "0")}`;
}

const req = (input, key, label) => {
  const v = input?.[key];
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    throw new ApiError(400, "missing_field", `${label}(${key})`);
  }
  return typeof v === "string" ? v.trim() : v;
};
const num = (input, key, label, min, max) => {
  const v = input?.[key];
  const n = typeof v === "number" ? v : Number(v);
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "") || Number.isNaN(n)) {
    throw new ApiError(400, "missing_field", `${label}(${key})`);
  }
  if (typeof min === "number" && n < min) throw new ApiError(400, "bad_value", `${label}不能小于${min}`);
  if (typeof max === "number" && n > max) throw new ApiError(400, "bad_value", `${label}不能大于${max}`);
  return n;
};

// 占桶：除已放行、已返工外都占桶位。
export function occupiedSlots(db) {
  return db.barrels.filter(b => b.status !== "已放行" && b.status !== "已返工").length;
}

function findBarrel(db, id) {
  const b = db.barrels.find(x => x.id === id);
  if (!b) throw new ApiError(404, "barrel_not_found", id);
  return b;
}

function assertNotFrozen(b) {
  if (b.status === "已冻结") throw new ApiError(409, "barrel_frozen", (b.freezeReasons || []).join("; "));
}

function freeze(db, b, reasons, now, evidence) {
  b.status = "已冻结";
  b.frozenAt = new Date(now).toISOString();
  b.freezeReasons ||= [];
  for (const r of reasons) if (!b.freezeReasons.includes(r)) b.freezeReasons.push(r);
  b.events.push({ at: new Date(now).toISOString(), type: "冻结", detail: reasons.join("；"), evidence: evidence || null });
}

function addEvent(b, now, type, detail, extra) {
  b.events.push({ at: new Date(now).toISOString(), type, detail, ...(extra || {}) });
}

// ---------- 配伍处置方案 ----------
// 用量以体积 V(L) 与浓度(mg/L) 估算；先破氰→再沉淀重金属→还原氧化剂→中和→静置复检。
export function buildPlan(r, now) {
  const V = r.volume;
  const steps = [];
  const add = s => steps.push({ index: steps.length, ...s });

  if (r.temperature > TEMP_COOL && r.temperature < TEMP_FREEZE) {
    add({
      code: "cool", name: "冷却降温", reagent: "冰水浴/夹套冷却", amount: "冷却至≤35°C",
      orderNote: "任何投药之前先冷却；严禁边高温边投药", maxRise: 0,
      tempLimit: TEMP_COOL, checks: [{ key: "temperature", op: "<=", limit: TEMP_COOL, label: "温度≤35°C" }]
    });
  }

  if (r.cyanide > LIMITS.cyanide) {
    add({
      code: "cn-alkali", name: "破氰①调碱", reagent: "10%氢氧化钠(NaOH)",
      amount: `约${Math.ceil((V * 0.3) / 0.1)}g 10%碱液，将pH调至10.5~11`,
      formula: "m≈V×0.3 g（纯NaOH，按V估），以10%溶液投加",
      orderNote: "先调碱，严禁先加酸或先加次氯酸钠", maxRise: 5, tempLimit: TEMP_FREEZE,
      checks: [{ key: "ph", op: ">=", limit: 10.5, label: "pH≥10.5" }]
    });
    add({
      code: "cn-primary", name: "破氰②一级氧化", reagent: "10%次氯酸钠(NaClO)",
      amount: `约${Math.ceil((V * r.cyanide * 2.85) / 0.1)}g 10%NaClO`,
      formula: "m(纯NaClO)≈V×氰化物mg/L×2.85 g",
      orderNote: "pH≥10.5条件下缓慢投加并搅拌，控温≤40°C；此步禁止与酸同加", maxRise: 5, tempLimit: TEMP_FREEZE,
      checks: []
    });
    add({
      code: "cn-secondary", name: "破氰③二级氧化", reagent: "10%盐酸回调+次氯酸钠",
      amount: `盐酸适量回调pH 8.0~8.5；NaClO约${Math.ceil((V * r.cyanide * 1.5) / 0.1)}g 10%液`,
      formula: "二级NaClO≈V×氰化物mg/L×1.5 g",
      orderNote: "确认一级反应完成后再用少量盐酸回调，再投次氯酸钠；氰不达标禁止加酸中和", maxRise: 5, tempLimit: TEMP_FREEZE,
      checks: [{ key: "cyanide", op: "<", limit: LIMITS.cyanide, label: `氰化物<${LIMITS.cyanide}mg/L` }]
    });
  }

  if (r.heavyMetal > LIMITS.heavyMetal) {
    add({
      code: "metal-lime", name: "重金属沉淀", reagent: "10%石灰乳(Ca(OH)₂)+PAM",
      amount: `石灰乳${Math.ceil(V * 0.5)}g调pH 8.5~9.5；PAM ${Math.ceil(V * 3)}mg`,
      formula: "石灰乳≈V×0.5 g；PAM≈V×3 mg",
      orderNote: "须在破氰完成后进行；缓慢加乳搅拌，观察絮凝，沉淀静置≥60分钟", maxRise: 5, tempLimit: TEMP_FREEZE,
      checks: [{ key: "heavyMetal", op: "<", limit: LIMITS.heavyMetal, label: `重金属<${LIMITS.heavyMetal}mg/L` }]
    });
  }

  if (r.oxidizer > LIMITS.oxidizer) {
    add({
      code: "ox-quench", name: "氧化剂还原", reagent: "硫代硫酸钠(Na₂S₂O₃)",
      amount: `约${Math.ceil(V * r.oxidizer * 3.0)}g，配成10%溶液缓加`,
      formula: "m≈V×氧化剂mg/L×3.0 g",
      orderNote: "破氰、沉金属完成后再还原残余氧化剂；小量缓加，监测温度", maxRise: 2, tempLimit: TEMP_FREEZE,
      checks: [{ key: "oxidizer", op: "<", limit: LIMITS.oxidizer, label: `氧化剂<${LIMITS.oxidizer}mg/L` }]
    });
  }

  // 中和：根据检测/过程pH选择投加方向
  if (r.ph < LIMITS.phMin) {
    add({
      code: "neutral-up", name: "中和调碱", reagent: "5%碳酸氢钠(NaHCO₃)",
      amount: `约${Math.ceil((V * (LIMITS.phMin - r.ph) * 0.5) / 0.05)}g 5%溶液，调pH至6~9`,
      formula: "m≈V×(目标pH-当前pH)×0.5 g（纯品，按5%液投）",
      orderNote: "含氰废液必须破氰合格后方可中和", maxRise: 2, tempLimit: TEMP_FREEZE,
      checks: [{ key: "ph", op: ">=", limit: LIMITS.phMin, label: "pH≥6" }]
    });
  } else if (r.ph > LIMITS.phMax) {
    add({
      code: "neutral-down", name: "中和调酸", reagent: "10%盐酸(HCl)",
      amount: `约${Math.ceil((V * (r.ph - LIMITS.phMax) * 0.4) / 0.1)}g 10%盐酸，调pH至6~9`,
      formula: "m≈V×(当前pH-目标pH)×0.4 g（纯品，按10%酸投）",
      orderNote: "小量缓慢投加并搅拌，禁止与含氰原液、氧化剂浓液同时接触", maxRise: 3, tempLimit: TEMP_FREEZE,
      checks: [{ key: "ph", op: "<=", limit: LIMITS.phMax, label: "pH≤9" }]
    });
  }

  add({
    code: "settle", name: "静置稳定复检", reagent: "不投药（仅搅拌后静置≥60分钟）",
    amount: "0", orderNote: "确认全部终点：pH6~9、氰<0.5、重金属<0.5、氧化剂<1.0、温度≤30°C；含污泥另排危废",
    maxRise: 2, tempLimit: TEMP_FREEZE,
    checks: [
      { key: "ph", op: "range", min: LIMITS.phMin, max: LIMITS.phMax, label: "pH 6~9" },
      { key: "cyanide", op: "<", limit: LIMITS.cyanide, label: `氰<${LIMITS.cyanide}mg/L` },
      { key: "heavyMetal", op: "<", limit: LIMITS.heavyMetal, label: `重金属<${LIMITS.heavyMetal}mg/L` },
      { key: "oxidizer", op: "<", limit: LIMITS.oxidizer, label: `氧化剂<${LIMITS.oxidizer}mg/L` },
      { key: "temperature", op: "<=", limit: TEMP_RELEASE, label: `温度≤${TEMP_RELEASE}°C` }
    ]
  });

  return { generatedAt: new Date(now).toISOString(), steps, orderNote: "按序号顺序投加；任一步温升或终点异常立即停手并报告，不得跳步" };
}

export function planExpired(barrel, now) {
  const at = barrel.plan?.generatedAt;
  return !at || now - new Date(at).getTime() > PLAN_TTL_MS;
}

// ---------- 操作 ----------
export function createBarrel(db, input, now = Date.now()) {
  if (occupiedSlots(db) >= SLOT_LIMIT) throw new ApiError(409, "no_slot", `桶位已满(${SLOT_LIMIT})`);
  const sourceBatch = req(input, "sourceBatch", "来源药液批次");
  const sourceStep = req(input, "sourceStep", "来源工序");
  const operator = req(input, "operator", "建档操作员");
  const barrel = {
    id: wbId(now),
    sourceBatch,
    sourceStep,
    sourceItemCode: input.sourceItemCode ? String(input.sourceItemCode).trim() : null,
    operator,
    status: "待检测",
    readings: [],
    plan: null,
    doses: [],
    waybill: null,
    releasedBy: null,
    releasedAt: null,
    legacy: false,
    parentBarrelId: input.parentBarrelId ? String(input.parentBarrelId) : null,
    reworkReason: input.reason ? String(input.reason) : null,
    freezeReasons: [],
    events: [{ at: new Date(now).toISOString(), type: "建档", detail: `关联批次${sourceBatch}/${sourceStep}，桶位${occupiedSlots(db) + 1}` }]
  };
  db.barrels.unshift(barrel);
  return barrel;
}

export function submitReadings(db, id, input, now = Date.now()) {
  const b = findBarrel(db, id);
  assertNotFrozen(b);
  if (b.status !== "待检测") throw new ApiError(409, "invalid_status", `当前状态${b.status}，仅待检测可录入检测`);
  const reading = {
    at: new Date(now).toISOString(),
    ph: num(input, "ph", "pH", 0, 14),
    cyanide: num(input, "cyanide", "氰化物mg/L", 0),
    heavyMetal: num(input, "heavyMetal", "重金属mg/L", 0),
    oxidizer: num(input, "oxidizer", "氧化剂mg/L", 0),
    temperature: num(input, "temperature", "温度°C", -10, 100),
    volume: num(input, "volume", "体积L", 0.01),
    operator: req(input, "operator", "检测操作员"),
    note: input.note ? String(input.note) : ""
  };
  b.readings.push(reading);
  addEvent(b, now, "检测", `pH${reading.ph} 氰${reading.cyanide} 重金属${reading.heavyMetal} 氧化剂${reading.oxidizer} ${reading.temperature}°C`);
  if (reading.temperature >= TEMP_FREEZE) {
    freeze(db, b, [`检测温度${reading.temperature}°C≥${TEMP_FREEZE}°C超温`], now, reading);
    return b;
  }
  b.plan = buildPlan(reading, now);
  b.status = "待处置";
  addEvent(b, now, "方案", `生成${b.plan.steps.length}步配伍处置方案，24小时内有效`);
  return b;
}

function checkEndpoint(step, post, now) {
  const failures = [];
  const v = k => post?.[k];
  for (const c of step.checks || []) {
    const x = Number(v(c.key));
    if (Number.isNaN(x)) failures.push(`${c.label}缺读数`);
    else if (c.op === ">=" && !(x >= c.limit)) failures.push(`${c.label}未达（实测${x}）`);
    else if (c.op === "<=" && !(x <= c.limit)) failures.push(`${c.label}超限（实测${x}）`);
    else if (c.op === "<" && !(x < c.limit)) failures.push(`${c.label}未达（实测${x}）`);
    else if (c.op === "range" && !(x >= c.min && x <= c.max)) failures.push(`${c.label}越界（实测${x}）`);
  }
  return failures;
}

export function dose(db, id, input, now = Date.now()) {
  const b = findBarrel(db, id);
  assertNotFrozen(b);
  if (b.status !== "待处置" && b.status !== "处置中") throw new ApiError(409, "invalid_status", `当前状态${b.status}`);
  if (planExpired(b, now)) {
    freeze(db, b, ["配伍处置方案超过24小时已过期"], now);
    throw new ApiError(409, "plan_expired", "方案过期，须返工另起批次");
  }
  const operator = req(input, "operator", "投药操作员");
  const stepIndex = num(input, "stepIndex", "步骤序号", 0);
  const step = b.plan.steps[stepIndex];
  if (!step) throw new ApiError(400, "bad_step", `步骤${stepIndex}不存在`);
  const doneCount = b.doses.length;
  if (stepIndex !== doneCount) {
    // 重复/并发抢步：已经投过的步骤不能再投；跳步拒绝。两者都不算半批次，不改桶。
    throw new ApiError(409, "step_conflict", `下一步应为${doneCount}（${b.plan.steps[doneCount]?.name || "无"}），收到${stepIndex}`);
  }
  const actualAmount = num(input, "actualAmount", "实际用量", 0);
  const post = input.postReadings;
  if (!post || typeof post !== "object") throw new ApiError(400, "missing_field", "投后读数(postReadings)");
  for (const k of ["ph", "cyanide", "heavyMetal", "oxidizer", "temperature"]) {
    if (post[k] === undefined || post[k] === null || Number.isNaN(Number(post[k]))) {
      throw new ApiError(400, "missing_field", `投后读数${k}`);
    }
  }
  post.ph = Number(post.ph); post.cyanide = Number(post.cyanide);
  post.heavyMetal = Number(post.heavyMetal); post.oxidizer = Number(post.oxidizer);
  post.temperature = Number(post.temperature);

  const prevTemp = b.doses.length ? b.doses[b.doses.length - 1].postReadings.temperature : b.readings[b.readings.length - 1].temperature;
  const rise = Number((post.temperature - prevTemp).toFixed(2));
  const record = {
    at: new Date(now).toISOString(), stepIndex, stepName: step.name, reagent: step.reagent,
    plannedAmount: step.amount, actualAmount, unit: step.code === "settle" ? "无" : "g",
    operator, rise, postReadings: post, note: input.note ? String(input.note) : ""
  };

  // 超温硬冻结
  if (post.temperature >= TEMP_FREEZE) {
    b.doses.push(record);
    freeze(db, b, [`投后温度${post.temperature}°C≥${TEMP_FREEZE}°C超温`], now, record);
    throw new ApiError(422, "over_temperature", `投后超温${post.temperature}°C，已冻结`);
  }
  // 温升异常硬冻结（冷却步允许负温升）
  const maxRise = typeof step.maxRise === "number" ? step.maxRise : MAX_RISE_DEFAULT;
  if (rise > maxRise) {
    b.doses.push(record);
    freeze(db, b, [`${step.name}温升${rise}°C超过允许${maxRise}°C`], now, record);
    throw new ApiError(422, "temperature_spike", `温升${rise}°C超限，已冻结`);
  }
  const failures = checkEndpoint(step, post);
  if (failures.length) {
    b.doses.push(record);
    freeze(db, b, failures.map(f => `${step.name}终点异常：${f}`), now, record);
    throw new ApiError(422, "endpoint_failed", failures.join("；"));
  }

  b.doses.push(record);
  b.status = "处置中";
  addEvent(b, now, "投药", `${step.name} 实投${actualAmount} 温升${rise}°C`, { by: operator });
  if (b.doses.length === b.plan.steps.length) {
    b.status = "待复检";
    addEvent(b, now, "处置完成", "全部步骤终点合格，等待复检测温与放行复核");
  }
  return b;
}

export function release(db, id, input, now = Date.now()) {
  const b = findBarrel(db, id);
  assertNotFrozen(b);
  if (b.status !== "待复检") throw new ApiError(409, "invalid_status", `当前状态${b.status}，仅待复检可放行`);
  if (planExpired(b, now)) {
    freeze(db, b, ["处置方案超过24小时，终点数据过期"], now);
    throw new ApiError(409, "plan_expired", "已过期，须返工另起批次");
  }
  const releaser = req(input, "releaser", "放行人");
  const waybillNo = req(input, "waybillNo", "承运单据号");
  const carrier = req(input, "carrier", "承运单位");
  const operators = new Set([b.operator, ...b.readings.map(r => r.operator), ...b.doses.map(d => d.operator)]);
  if ([...operators].includes(releaser)) {
    throw new ApiError(403, "separation_required", "放行人与操作/检测/投药人必须不同");
  }
  const last = b.doses[b.doses.length - 1];
  const finalReadings = last.postReadings;
  const fails = [];
  if (!(finalReadings.ph >= LIMITS.phMin && finalReadings.ph <= LIMITS.phMax)) fails.push(`pH ${finalReadings.ph} 不在6~9`);
  if (!(finalReadings.cyanide < LIMITS.cyanide)) fails.push(`氰化物 ${finalReadings.cyanide}`);
  if (!(finalReadings.heavyMetal < LIMITS.heavyMetal)) fails.push(`重金属 ${finalReadings.heavyMetal}`);
  if (!(finalReadings.oxidizer < LIMITS.oxidizer)) fails.push(`氧化剂 ${finalReadings.oxidizer}`);
  if (!(finalReadings.temperature <= TEMP_RELEASE)) fails.push(`温度 ${finalReadings.temperature}°C>${TEMP_RELEASE}°C`);
  if (fails.length) {
    freeze(db, b, fails.map(f => `放行终点不合格：${f}`), now);
    throw new ApiError(422, "release_endpoint_failed", fails.join("；"));
  }
  b.status = "已放行";
  b.waybill = { no: waybillNo, carrier, at: new Date(now).toISOString() };
  b.releasedBy = releaser;
  b.releasedAt = new Date(now).toISOString();
  addEvent(b, now, "放行", `承运单${waybillNo}/${carrier}，放行人${releaser}`);
  return b;
}

export function markAnomaly(db, id, input, now = Date.now()) {
  const b = findBarrel(db, id);
  if (b.status === "已放行" || b.status === "已返工") throw new ApiError(409, "invalid_status", b.status);
  const reason = req(input, "reason", "异常原因");
  const by = req(input, "by", "报告人");
  freeze(db, b, [`异常报告：${reason}（${by}）`], now);
  return b;
}

// 任何对处置/检测记录的改动尝试 → 冻结，记录不可变。
export function tamperAttempt(db, id, input, now = Date.now()) {
  const b = findBarrel(db, id);
  if (b.status !== "已放行" && b.status !== "已返工") {
    freeze(db, b, ["检测到记录改动/删除尝试，记录不可变"], now, input || null);
  }
  throw new ApiError(409, "record_immutable", "处置与检测记录不可修改；如需纠正请返工另起批次");
}

export function rework(db, id, input, now = Date.now()) {
  const old = findBarrel(db, id);
  if (old.status !== "已冻结") throw new ApiError(409, "invalid_status", "仅已冻结批次可返工");
  const operator = req(input, "operator", "返工操作员");
  const reason = req(input, "reason", "返工原因");
  if (occupiedSlots(db) >= SLOT_LIMIT) throw new ApiError(409, "no_slot", `桶位已满(${SLOT_LIMIT})`);
  const nb = createBarrel(db, {
    sourceBatch: old.sourceBatch, sourceStep: old.sourceStep, sourceItemCode: old.sourceItemCode,
    operator, parentBarrelId: old.id, reason: `返工自${old.id}：${reason}`
  }, now);
  nb.readings = [];
  old.status = "已返工";
  old.reworkBarrelId = nb.id;
  old.reworkAt = new Date(now).toISOString();
  old.events.push({ at: new Date(now).toISOString(), type: "返工转出", detail: `另起批次${nb.id}：${reason}（${operator}）` });
  nb.events.push({ at: new Date(now).toISOString(), type: "返工转入", detail: `源自${old.id}，保留全部关联；须重新检测，不自动放行` });
  return nb;
}

export function compatibility(db, ids, now = Date.now()) {
  if (!Array.isArray(ids) || ids.length < 2) throw new ApiError(400, "bad_request", "至少选择两个桶");
  const barrels = ids.map(i => findBarrel(db, i));
  for (const b of barrels) {
    if (b.status === "已冻结") throw new ApiError(409, "barrel_frozen", `${b.id}已冻结，禁止参与混装`);
    if (b.status === "已放行" || b.status === "已返工") throw new ApiError(409, "invalid_status", `${b.id}为${b.status}`);
  }
  const parties = barrels.map(b => ({ id: b.id, readings: b.readings[b.readings.length - 1] }));
  const result = checkCompatibility(parties);
  for (const b of barrels) addEvent(b, now, "配伍检查", result.compatible ? "相容" : result.message);
  return result;
}

// ---------- 并发与幂等 ----------
const barrelQueues = new Map(); // id -> Promise 链尾

export async function withBarrelLock(id, fn) {
  const prev = barrelQueues.get(id) || Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  const next = prev.then(() => gate, () => gate);
  barrelQueues.set(id, next);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    // 链尾仍是自己这节才清理；已有后来者时保留链。
    if (barrelQueues.get(id) === next) barrelQueues.delete(id);
  }
}

// 业务动作包装：幂等键去重（只缓存成功结果）；并发时后来者收到 409，不留半批次。
export async function idempotent(db, idemKey, action) {
  if (idemKey) {
    const hit = db.idempotency?.[idemKey];
    if (hit) return { replay: true, status: hit.status, body: hit.body };
  }
  const result = await action();
  if (idemKey) {
    db.idempotency ||= {};
    db.idempotency[idemKey] = { status: result.status, body: result.body, at: new Date().toISOString() };
  }
  return { replay: false, ...result };
}

export function summarizeBarrel(b) {
  const latest = b.readings[b.readings.length - 1] || null;
  return {
    ...b,
    planStepCount: b.plan?.steps.length || 0,
    doseCount: b.doses.length,
    latestReadings: latest,
    planExpired: b.plan ? Date.now() - new Date(b.plan.generatedAt).getTime() > PLAN_TTL_MS : null
  };
}
