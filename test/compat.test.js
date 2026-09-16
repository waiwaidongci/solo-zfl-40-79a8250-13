import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompatibility, tagsFromReadings } from "../src/compat.js";

const R = (over = {}) => ({ ph: 7, cyanide: 0, heavyMetal: 0, oxidizer: 0, temperature: 25, volume: 100, ...over });

test("标签：酸碱氰重金属氧化剂高温", () => {
  assert.deepEqual([...tagsFromReadings(R({ ph: 5 }))], ["酸性"]);
  assert.deepEqual([...tagsFromReadings(R({ ph: 9.6 }))], ["碱性"]);
  assert.deepEqual([...tagsFromReadings(R({ cyanide: 1 }))], ["含氰"]);
  assert.deepEqual([...tagsFromReadings(R({ heavyMetal: 2 }))], ["重金属"]);
  assert.deepEqual([...tagsFromReadings(R({ oxidizer: 3 }))], ["氧化剂"]);
  assert.deepEqual([...tagsFromReadings(R({ temperature: 36 }))], ["高温"]);
});

test("中性常规废液彼此相容", () => {
  const r = checkCompatibility([{ id: "A", readings: R() }, { id: "B", readings: R() }]);
  assert.equal(r.compatible, true);
  assert.equal(r.conflicts.length, 0);
});

test("含氰与酸性冲突（氰化氢风险）", () => {
  const r = checkCompatibility([{ id: "A", readings: R({ cyanide: 5 }) }, { id: "B", readings: R({ ph: 3 }) }]);
  assert.equal(r.compatible, false);
  assert.ok(r.conflicts.some(c => c.tagA === "含氰" && c.tagB === "酸性"));
});

test("含氰与氧化剂冲突", () => {
  const r = checkCompatibility([{ id: "A", readings: R({ cyanide: 5 }) }, { id: "B", readings: R({ oxidizer: 5 }) }]);
  assert.equal(r.compatible, false);
  assert.ok(r.conflicts.length >= 1);
});

test("高温桶不得与任何他桶混装", () => {
  const r = checkCompatibility([{ id: "A", readings: R({ temperature: 38 }) }, { id: "B", readings: R({ temperature: 25 }) }]);
  assert.equal(r.compatible, false);
  assert.ok(r.conflicts.some(c => c.reason.includes("高温") || c.reason.includes("温差")));
});

test("温差超过15°C禁止混装", () => {
  const r = checkCompatibility([{ id: "A", readings: R({ temperature: 20 }) }, { id: "B", readings: R({ temperature: 37 }) }]);
  assert.equal(r.compatible, false);
});

test("缺检测数据的桶不得参与混装（旧数据待检测）", () => {
  const r = checkCompatibility([{ id: "OLD", readings: null }, { id: "B", readings: R() }]);
  assert.equal(r.compatible, false);
  assert.deepEqual(r.untested, ["OLD"]);
});

test("三个桶两两检查，任一冲突即整体不相容", () => {
  const r = checkCompatibility([
    { id: "A", readings: R({ ph: 2 }) },
    { id: "B", readings: R({ cyanide: 4 }) },
    { id: "C", readings: R() }
  ]);
  assert.equal(r.compatible, false);
});
