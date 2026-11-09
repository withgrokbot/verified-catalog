// UTC-day counter only. The file holds a date and a count, never an address.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function dailyFileStore(dir) {
  const file = join(dir, "daily.json");
  return {
    load() {
      try {
        const j = JSON.parse(readFileSync(file, "utf8"));
        if (j && typeof j.day === "string" && Number.isInteger(j.count) && j.count >= 0 && j.count <= 1_000_000) return { day: j.day, count: j.count };
      } catch (_) { /* first boot, or an unreadable file, starts at zero */ }
      return { day: "", count: 0 };
    },
    save(d) {
      try {
        mkdirSync(dir, { recursive: true });
        const tmp = file + ".tmp";
        writeFileSync(tmp, JSON.stringify({ day: String(d.day), count: Number(d.count) }));
        renameSync(tmp, file);
      } catch (_) { /* the in-memory counter still applies for this process */ }
    },
  };
}
