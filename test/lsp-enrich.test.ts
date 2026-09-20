/**
 * LSP enrichment tier: registry selection + graceful degradation. These run
 * without any language server installed — they assert the OPT-IN promise that
 * `graft build --lsp` is a safe no-op when no server applies (never a crash,
 * never a mutated graph), which is the contract the build relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickServer, LSP_SERVERS } from "../src/graph/lsp/registry.js";
import { enrichWithLsp } from "../src/graph/lsp/enrich.js";
import type { GraphV1 } from "../src/graph/types.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { patchBuildConfig, readBuildConfig as readBuildConfigFor, readLsp } from "../src/util/state.js";

test("pickServer: no languages present → no server", () => {
  assert.equal(pickServer(new Set()), null);
});

test("pickServer: a language no registered server covers → null", () => {
  assert.equal(pickServer(new Set(["cobol", "fortran"])), null);
});

test("registry rows are well-formed (languages, command, languageId)", () => {
  for (const s of LSP_SERVERS) {
    assert.ok(s.languages.length > 0 && s.command && s.languageId, `${s.command} row shape`);
    assert.ok(Array.isArray(s.args), `${s.command} args is an array`);
  }
});

test("enrichWithLsp is a no-op when no server matches the repo's languages", async () => {
  // A graph whose only file is an unsupported language → no server is picked →
  // no process spawned, graph returned unchanged.
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["text"], scopes: [] },
    nodes: [
      { id: "notes.txt", name: "notes.txt", kind: "file", path: "notes.txt", span: "L1-L1",
        signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [],
  };
  const before = graph.edges.length;
  const r = await enrichWithLsp(graph, "/tmp/does-not-matter");
  assert.equal(r.server, null, "no server selected for an unsupported language");
  assert.equal(r.added, 0);
  assert.equal(graph.edges.length, before, "graph edges untouched");
});

/**
 * Persistence + incrementality (F4). These need no language server: the choice
 * is read from `.graft/config.json`, and edges from unchanged files are carried
 * forward before the (here always no-op) enrichment runs.
 */

test("build: --lsp persists the choice, and a later no-flag build honours it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-lsp-persist-"));
  try {
    writeFileSync(join(dir, "a.cobol"), "nothing indexable\n");
    await buildGraph(dir, { lsp: true });
    assert.equal(readBuildConfigFor(dir)?.lsp, undefined, "buildGraph itself never persists — the CLI does");

    // What the CLI writes:
    patchBuildConfig(dir, { lsp: true });
    assert.equal(readLsp(dir), true, "the persisted choice reads back");
    patchBuildConfig(dir, { lsp: false });
    assert.equal(readLsp(dir), false, "and can be turned back off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unchanged file keeps its lsp_resolved edges across an incremental rebuild", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-lsp-carry-"));
  try {
    // The calls here are through an object the AST resolver cannot type, so it
    // produces no edge for them — exactly the gap a language server fills, and
    // what makes the injected edges below the only source of these two.
    writeFileSync(join(dir, "keep.py"), "def a():\n    return 1\n\n\ndef b(obj):\n    return obj.a()\n");
    writeFileSync(join(dir, "touch.py"), "def c():\n    return 2\n\n\ndef d(obj):\n    return obj.c()\n");
    await buildGraph(dir);

    // Stand in for a language server: stamp one compiler-grade edge into each
    // file's graph, exactly as enrichWithLsp would have.
    const graphPath = wiringPath(join(dir, "graft"));
    const g = readGraph(graphPath)!;
    g.edges.push({ source: "keep.py#b", target: "keep.py#a", relation: "calls", confidence: "lsp_resolved" });
    g.edges.push({ source: "touch.py#d", target: "touch.py#c", relation: "calls", confidence: "lsp_resolved" });
    writeFileSync(graphPath, JSON.stringify(g));

    // Turn the persisted flag on and rebuild with no flag at all — the refresh path.
    patchBuildConfig(dir, { lsp: true });
    writeFileSync(join(dir, "touch.py"), "def c():\n    return 2\n\n\ndef d(obj):\n    # edited\n    return obj.c()\n");
    await buildGraph(dir);

    const after = readGraph(graphPath)!;
    const lsp = after.edges.filter((e) => e.confidence === "lsp_resolved");
    assert.ok(
      lsp.some((e) => e.source === "keep.py#b" && e.target === "keep.py#a"),
      "the unchanged file's compiler-grade edge is carried forward",
    );
    assert.ok(
      !lsp.some((e) => e.source === "touch.py#d"),
      "the edited file's edge is dropped, to be re-derived by the enrichment pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
