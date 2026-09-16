// 废液配伍（相容性）规则引擎。
// 蓝晒暗房废液按危害特征打标签；下列组合禁止混装，必须分桶单独处置。

export const HAZARD_LABELS = {
  ACID: "酸性",
  ALKALI: "碱性",
  CYANIDE: "含氰",
  HEAVY_METAL: "重金属",
  OXIDIZER: "氧化剂",
  HOT: "高温"
};

// 硬冲突：两两不可混装（键按字母序）
const CONFLICTS = [
  ["酸性", "含氰", "酸会释放剧毒氰化氢气体"],
  ["酸性", "氧化剂", "强氧化剂遇酸可放热并释放氯气/有毒气体"],
  ["酸性", "碱性", "酸碱直接混装剧烈放热、飞溅"],
  ["含氰", "氧化剂", "不可控氧化反应，可能生成剧毒氯化氰"],
  ["含氰", "重金属", "重金属催化氰化物分解并可能形成不稳定络合物，须先破氰后沉金属"],
  ["氧化剂", "重金属", "氧化态改变可致放热与金属溶出，禁止混装"],
  ["氧化剂", "碱性", "次氯酸盐等在强碱下不稳定并放热，禁止混装"],
  ["高温", "酸性", "高温加剧酸雾与失控反应"],
  ["高温", "含氰", "高温下氰化物挥发/分解风险"],
  ["高温", "氧化剂", "高温加速氧化放热，失控风险"],
  ["高温", "重金属", "高温影响沉淀稳定与桶体安全"],
  ["高温", "碱性", "高温下强碱飞溅风险加剧"]
];

const TEMP_HOT_THRESHOLD = 35; // °C，超过即打“高温”标签，禁止与它桶混装

export function tagsFromReadings(r) {
  const tags = new Set();
  if (r == null) return tags;
  if (typeof r.ph === "number") {
    if (r.ph < 6) tags.add(HAZARD_LABELS.ACID);
    if (r.ph > 9) tags.add(HAZARD_LABELS.ALKALI);
  }
  if ((r.cyanide ?? 0) > 0.5) tags.add(HAZARD_LABELS.CYANIDE);
  if ((r.heavyMetal ?? 0) > 0.5) tags.add(HAZARD_LABELS.HEAVY_METAL);
  if ((r.oxidizer ?? 0) > 0) tags.add(HAZARD_LABELS.OXIDIZER);
  if (typeof r.temperature === "number" && r.temperature > TEMP_HOT_THRESHOLD) tags.add(HAZARD_LABELS.HOT);
  return tags;
}

function key(a, b) { return [a, b].sort().join("§"); }

const CONFLICT_MAP = new Map();
for (const [a, b, reason] of CONFLICTS) CONFLICT_MAP.set(key(a, b), reason);

export function conflictReasons(tagsA, tagsB) {
  const reasons = [];
  for (const a of tagsA) {
    for (const b of tagsB) {
      const reason = CONFLICT_MAP.get(key(a, b));
      if (reason) reasons.push({ tagA: a, tagB: b, reason });
    }
  }
  return reasons;
}

// 检查一组废液（每条形如 { id, readings } 或直接 readings）能否混装同一转运容器。
// 任一无检测数据 → incompatible（旧数据待检测，绝不放行混装）。
export function checkCompatibility(parties) {
  const enriched = parties.map((p, i) => {
    const readings = p.readings || p;
    const tags = [...tagsFromReadings(readings)];
    const measured = readings && typeof readings.ph === "number" &&
      typeof readings.cyanide === "number" &&
      typeof readings.heavyMetal === "number" &&
      typeof readings.oxidizer === "number" &&
      typeof readings.temperature === "number";
    return { id: p.id || `#${i + 1}`, tags, measured, temperature: readings?.temperature };
  });

  for (const e of enriched) {
    if (!e.measured) {
      return {
        compatible: false,
        conflicts: [],
        untested: [e.id],
        message: `${e.id} 缺检测数据，待检测废液不得参与混装/放行`
      };
    }
  }

  const conflicts = [];
  for (let i = 0; i < enriched.length; i += 1) {
    for (let j = i + 1; j < enriched.length; j += 1) {
      for (const reason of conflictReasons(enriched[i].tags, enriched[j].tags)) {
        conflicts.push({ a: enriched[i].id, b: enriched[j].id, ...reason });
      }
    }
  }
  // 高温桶只能与同为高温且化学相容者同运；高温×常温一律先冷却、禁混。
  for (let i = 0; i < enriched.length; i += 1) {
    for (let j = i + 1; j < enriched.length; j += 1) {
      const hotI = enriched[i].tags.includes("高温");
      const hotJ = enriched[j].tags.includes("高温");
      if (hotI !== hotJ) {
        conflicts.push({ a: enriched[i].id, b: enriched[j].id, tagA: "高温", tagB: "常温", reason: "高温废液须单独冷却处置，不得与常温废液混装" });
      }
    }
  }
  // 桶间温差过大也禁止混装
  for (let i = 0; i < enriched.length; i += 1) {
    for (let j = i + 1; j < enriched.length; j += 1) {
      if (Math.abs((enriched[i].temperature || 0) - (enriched[j].temperature || 0)) > 15) {
        conflicts.push({ a: enriched[i].id, b: enriched[j].id, tagA: "温差", tagB: "温差", reason: "温差超过15°C，禁止混装" });
      }
    }
  }
  return {
    compatible: conflicts.length === 0,
    conflicts,
    untested: [],
    tags: Object.fromEntries(enriched.map(e => [e.id, e.tags])),
    message: conflicts.length ? "存在配伍冲突，不得混装" : "配伍相容"
  };
}
