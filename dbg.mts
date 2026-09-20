import { readFileSync } from "node:fs";
import { extractFile } from "./src/graph/extract.js";
const p = "/home/seunghyunoh/workspace/project/uw/Sementic-Listening-v2/src/hl_modules/se.py";
const { rawEdges } = extractFile("src/hl_modules/se.py", readFileSync(p, "utf8"), "python");
for (const e of rawEdges) {
  if (e.relation === "calls" && (e.name === "snr_metric" || e.boundType)) console.log(JSON.stringify(e));
}
