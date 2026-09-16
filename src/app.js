import http from "node:http";
import { loadDb, saveDb, withWriteLock } from "./db.js";
import { page } from "./page.js";
import * as waste from "./waste.js";

const fields = [["code", "底片编号"], ["plateSize", "玻璃板尺寸"], ["chemicalBatch", "药液批次"], ["exposure", "曝光时间"], ["waterSource", "冲洗水源"], ["box", "存放盒位"]];
const stages = ["待曝光", "冲洗中", "待入盒", "已交付"];

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const e = new waste.ApiError(400, "bad_json", "请求体不是合法JSON");
    throw e;
  }
}

function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function computeStats(items) {
  const stats = Object.fromEntries(stages.map(s => [s, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}

// 在同一把全局写锁内完成 读库→业务变更→落盘，保证并发请求不互相覆盖。
// 业务函数可能在落库冻结证据后再抛错（超温/温升/终点/过期/改动），
// 因此必须用 finally 落盘：失败也要把冻结状态与证据持久化，不能留下还能继续操作的桶。
async function mutate(dbPath, fn) {
  return withWriteLock(dbPath, async () => {
    const db = await loadDb(dbPath);
    try {
      return await fn(db);
    } finally {
      await saveDb(dbPath, db);
    }
  });
}

// 幂等 + 单桶串行：重复提交只成功一次；并发投药/放行只有一个能进入。
async function barrelMutation(dbPath, barrelId, idemKey, fn) {
  return waste.withBarrelLock(barrelId, () =>
    mutate(dbPath, async db => {
      const res = await waste.idempotent(db, idemKey || null, async () => {
        const body = await fn(db);
        return { status: body?.__status || 200, body: body?.__body || body };
      });
      return res;
    })
  );
}

export function createApp(dbPath) {
  return http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data, null, 2));
    };
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const p = url.pathname;

      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page());
      }

      /* ---------- 底片（原有接口，保持一致） ---------- */
      if (req.method === "GET" && p === "/api/items") {
        const db = await loadDb(dbPath);
        return send(200, db.items.map(summarize));
      }
      if (req.method === "POST" && p === "/api/items") {
        const input = await readBody(req);
        const item = await mutate(dbPath, async db => {
          const it = { id: "CN-" + Date.now(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建底片" }] };
          db.items.unshift(it);
          return it;
        });
        return send(201, item);
      }
      const mPatch = p.match(/^\/api\/items\/([^/]+)$/);
      if (mPatch && req.method === "PATCH") {
        const input = await readBody(req);
        const item = await mutate(dbPath, async db => {
          const it = db.items.find(x => x.id === decodeURIComponent(mPatch[1]) || x.code === decodeURIComponent(mPatch[1]));
          if (!it) throw new waste.ApiError(404, "item_not_found");
          Object.assign(it, input);
          it.logs ||= [];
          it.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + it.status });
          return it;
        });
        return send(200, item);
      }
      const mLog = p.match(/^\/api\/items\/([^/]+)\/logs$/);
      if (mLog && req.method === "POST") {
        const input = await readBody(req);
        const item = await mutate(dbPath, async db => {
          const it = db.items.find(x => x.id === decodeURIComponent(mLog[1]) || x.code === decodeURIComponent(mLog[1]));
          if (!it) throw new waste.ApiError(404, "item_not_found");
          it.logs ||= [];
          it.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
          return it;
        });
        return send(201, item);
      }
      const mAction = p.match(/^\/api\/items\/([^/]+)\/action$/);
      if (mAction && req.method === "POST") {
        const input = await readBody(req);
        const item = await mutate(dbPath, async db => {
          const it = db.items.find(x => x.id === decodeURIComponent(mAction[1]) || x.code === decodeURIComponent(mAction[1]));
          if (!it) throw new waste.ApiError(404, "item_not_found");
          it.logs ||= [];
          it.steps ||= [];
          it.steps.push({ at: new Date().toISOString(), ...input });
          if (input.defect) it.defect = input.defect;
          if (input.step === "冲洗") it.status = "冲洗中";
          else if (input.step === "入盒") it.status = "待入盒";
          else if (input.step === "交付") it.status = "已交付";
          else it.status = "待曝光";
          it.logs.push({ at: new Date().toISOString(), step: input.step || "工艺", note: input.note || input.developStatus || "步骤记录" });
          return it;
        });
        return send(201, item);
      }
      if (req.method === "GET" && p === "/api/stats") {
        const db = await loadDb(dbPath);
        return send(200, computeStats(db.items));
      }

      /* ---------- 暗房废液 ---------- */
      if (req.method === "GET" && p === "/api/waste/barrels") {
        const db = await loadDb(dbPath);
        return send(200, db.barrels.map(waste.summarizeBarrel));
      }

      if (req.method === "POST" && p === "/api/waste/barrels") {
        const input = await readBody(req);
        const idemKey = req.headers["idempotency-key"];
        const res = await mutate(dbPath, db =>
          waste.idempotent(db, idemKey || null, async () => ({ status: 201, body: waste.createBarrel(db, input) }))
        );
        return send(res.status, res.body);
      }

      if (req.method === "POST" && p === "/api/waste/compatibility") {
        const input = await readBody(req);
        const result = await mutate(dbPath, db => waste.compatibility(db, input.ids));
        return send(200, result);
      }

      const mReading = p.match(/^\/api\/waste\/barrels\/([^/]+)\/readings$/);
      if (mReading && req.method === "POST") {
        const input = await readBody(req);
        const id = decodeURIComponent(mReading[1]);
        const res = await barrelMutation(dbPath, id, req.headers["idempotency-key"], db =>
          ({ __status: 201, __body: waste.submitReadings(db, id, input) })
        );
        return send(res.status, res.body);
      }
      const mDose = p.match(/^\/api\/waste\/barrels\/([^/]+)\/doses$/);
      if (mDose && req.method === "POST") {
        const input = await readBody(req);
        const id = decodeURIComponent(mDose[1]);
        const res = await barrelMutation(dbPath, id, req.headers["idempotency-key"], db =>
          ({ __status: 201, __body: waste.dose(db, id, input) })
        );
        return send(res.status, res.body);
      }
      const mRelease = p.match(/^\/api\/waste\/barrels\/([^/]+)\/release$/);
      if (mRelease && req.method === "POST") {
        const input = await readBody(req);
        const id = decodeURIComponent(mRelease[1]);
        const res = await barrelMutation(dbPath, id, req.headers["idempotency-key"], db =>
          ({ __body: waste.release(db, id, input) })
        );
        return send(res.status, res.body);
      }
      const mAnom = p.match(/^\/api\/waste\/barrels\/([^/]+)\/anomaly$/);
      if (mAnom && req.method === "POST") {
        const input = await readBody(req);
        const id = decodeURIComponent(mAnom[1]);
        const res = await barrelMutation(dbPath, id, req.headers["idempotency-key"], db =>
          ({ __body: waste.markAnomaly(db, id, input) })
        );
        return send(res.status, res.body);
      }
      const mRework = p.match(/^\/api\/waste\/barrels\/([^/]+)\/rework$/);
      if (mRework && req.method === "POST") {
        const input = await readBody(req);
        const id = decodeURIComponent(mRework[1]);
        const res = await barrelMutation(dbPath, id, req.headers["idempotency-key"], db =>
          ({ __status: 201, __body: waste.rework(db, id, input) })
        );
        return send(res.status, res.body);
      }

      // 记录不可变：任何对桶/记录的 PATCH/PUT/DELETE 一律拒绝并冻结（演示/防误改）。
      const mBarrel = p.match(/^\/api\/waste\/barrels\/([^/]+)(?:\/[^/]*)?$/);
      if (mBarrel && ["PATCH", "PUT", "DELETE"].includes(req.method)) {
        const input = await readBody(req).catch(() => ({}));
        const id = decodeURIComponent(mBarrel[1]);
        await mutate(dbPath, db => {
          try { waste.tamperAttempt(db, id, { method: req.method, input }); }
          catch (e) { return { blocked: true }; }
        });
        return send(409, { error: "record_immutable", detail: "处置与检测记录不可修改；如需纠正请返工另起批次" });
      }

      return send(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof waste.ApiError) return send(error.status, { error: error.code, detail: error.detail });
      send(500, { error: "internal_error", detail: error.message });
    }
  });
}
