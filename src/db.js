import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const defaultDbPath = join(__dirname, "..", "data", "cyanotype-negative-room.json");

export const seed = {
  items: [
    {
      code: "CN-001",
      plateSize: "18x24cm",
      chemicalBatch: "B-0620",
      exposure: "8分钟",
      waterSource: "井水过滤",
      box: "蓝盒A-03",
      status: "待入盒",
      defect: "边角显影不均",
      logs: [
        { at: "2026-06-20", step: "曝光", note: "阴天补时2分钟" },
        { at: "2026-06-21T03:50:30.042Z", step: "入盒", note: "放入A盒" }
      ],
      steps: [
        {
          at: "2026-06-21T03:50:30.042Z",
          step: "入盒",
          developStatus: "稳定",
          defect: "边角显影不均",
          repair: "边角重涂",
          note: "放入A盒"
        }
      ]
    }
  ],
  barrels: [],
  // 已占用的桶位（处理中/冻结/返工待新桶期间不释放）
  slots: [],
  idempotency: {}
};

// 进程内写锁：对同一个 JSON 文件，读-改-写串行化，避免并发请求互相覆盖。
let writeChain = Promise.resolve();

export function withWriteLock(dbPath, fn) {
  const run = writeChain.then(() => fn());
  // 不让单次失败污染后续写链
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

export async function loadDb(dbPath = defaultDbPath) {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await persist(dbPath, seed);
  }
  const raw = await readFile(dbPath, "utf8");
  const db = JSON.parse(raw);
  return migrate(db);
}

// 迁移：补齐旧版本缺失的集合。旧废液数据一律保持“待检测”，绝不自动放行。
export function migrate(db) {
  db.items ||= [];
  db.barrels ||= [];
  db.slots ||= [];
  db.idempotency ||= {};
  for (const barrel of db.barrels) {
    barrel.doses ||= [];
    barrel.readings ||= [];
    barrel.events ||= [];
    if (!barrel.status) {
      barrel.status = "待检测";
      barrel.legacy = true;
      barrel.freezeReasons ||= ["旧数据待检测"];
      barrel.events.push({ at: new Date().toISOString(), type: "迁移", detail: "历史数据迁入，须检测后方可处置，不自动放行" });
    }
  }
  return db;
}

export async function persist(dbPath, db) {
  const tmp = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

export async function saveDb(dbPath, db) {
  await persist(dbPath, db);
}
