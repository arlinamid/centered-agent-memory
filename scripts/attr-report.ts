import { loadConfig } from "../src/config.js";
import { openHub } from "../src/db/open.js";

const db = openHub(loadConfig().dbPath);
console.log("=== attribúció eszközönként ===");
for (const r of db.prepare(`
  select s.tool, a.method, a.confidence, count(*) c
  from sessions s left join attribution a on a.session_id = s.id
  group by s.tool, a.method, a.confidence order by s.tool, c desc`).all() as Array<Record<string, unknown>>) {
  console.log(`  ${String(r.tool).padEnd(13)} ${String(r.method).padEnd(16)} ${String(r.confidence).padEnd(8)} ${r.c}`);
}
console.log("\n=== lefedettség eszközönként ===");
for (const r of db.prepare(`
  select tool, count(*) total, sum(case when project_id is not null then 1 else 0 end) ok
  from sessions group by tool order by total desc`).all() as Array<Record<string, number | string>>) {
  const pct = Math.round((Number(r.ok) / Number(r.total)) * 100);
  console.log(`  ${String(r.tool).padEnd(13)} ${String(r.ok).padStart(4)}/${String(r.total).padStart(4)}  ${pct}%`);
}
console.log("\n=== bizonyíték eredet szerint ===");
for (const r of db.prepare(`select origin, count(*) c, count(distinct session_id) sess,
  sum(case when project_key is not null then 1 else 0 end) resolved
  from path_evidence group by origin order by c desc`).all() as Array<Record<string, unknown>>) {
  console.log(`  ${String(r.origin).padEnd(14)} sor:${String(r.c).padStart(6)}  session:${String(r.sess).padStart(5)}  feloldva:${r.resolved}`);
}
db.close();
