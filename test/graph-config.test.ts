/**
 * Config tier: a component named by a dotted path in configuration is a real
 * dependency, and `graft callers` should say so.
 *
 * The whole tier rests on one safety property — a dotted path is only a
 * CANDIDATE, and an edge appears solely when the path resolves to a module and
 * symbol this repo defines. Most tests here are therefore negative: they pin
 * that a third-party path, a version string, a comment and a docstring all
 * produce nothing, because that is what keeps scanning text for paths honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { dottedPaths } from "../src/graph/config.js";
import type { GraphV1 } from "../src/graph/types.js";

const MODEL = `class TFNet:
    pass


def make_model():
    return TFNet()
`;

function makeFixture(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-config-"));
  mkdirSync(join(dir, "src", "models"), { recursive: true });
  writeFileSync(join(dir, "src", "__init__.py"), "");
  writeFileSync(join(dir, "src", "models", "__init__.py"), "");
  writeFileSync(join(dir, "src", "models", "tfnet.py"), MODEL);
  for (const [rel, body] of Object.entries(extra)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

async function build(dir: string): Promise<GraphV1> {
  await buildGraph(dir);
  const g = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(g, "wiring graph should be written");
  return g!;
}

const refsTo = (g: GraphV1, target: string): string[] =>
  g.edges.filter((e) => e.relation === "references" && e.target === target).map((e) => e.source);

test("config: a JSON value naming a class wires the config file to it", async () => {
  const dir = makeFixture({
    "conf/train.json": JSON.stringify({ model_name: "src.models.tfnet.TFNet" }, null, 2),
  });
  try {
    const g = await build(dir);
    const edge = g.edges.find(
      (e) => e.source === "conf/train.json" && e.target === "src/models/tfnet.py#TFNet",
    );
    assert.ok(edge, "the config should reference the class it selects");
    assert.equal(edge!.relation, "references");
    assert.equal(edge!.confidence, "string_ref");
    assert.equal(edge!.line, 2, "the edge records the line the path appears on");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: YAML and TOML are read the same way", async () => {
  const dir = makeFixture({
    "conf/hydra.yaml": "model:\n  _target_: src.models.tfnet.TFNet\n",
    "conf/pyproject.toml": 'entry = "src.models.tfnet.make_model"\n',
  });
  try {
    const g = await build(dir);
    assert.ok(
      refsTo(g, "src/models/tfnet.py#TFNet").includes("conf/hydra.yaml"),
      "a Hydra _target_ resolves",
    );
    assert.ok(
      refsTo(g, "src/models/tfnet.py#make_model").includes("conf/pyproject.toml"),
      "a factory function is as much a wiring target as a class",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: a path naming a module rather than a symbol resolves to the file", async () => {
  const dir = makeFixture({
    "conf/m.json": JSON.stringify({ mod: "src.models.tfnet", short: "models.tfnet" }),
  });
  try {
    const g = await build(dir);
    assert.ok(
      refsTo(g, "src/models/tfnet.py").includes("conf/m.json"),
      "a path that names a module and no symbol wires to the module's file",
    );
    // `models.tfnet` is two segments, below the shape rule, so it is never even
    // a candidate — the guard that keeps ordinary compound words out.
    assert.equal(
      g.edges.filter((e) => e.source === "conf/m.json" && e.relation === "references").length,
      1,
      "only the three-segment path was considered",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: a third-party or unknown path produces no edge at all", async () => {
  const dir = makeFixture({
    "conf/x.json": JSON.stringify({
      a: "torch.nn.Module",
      b: "src.models.tfnet.NoSuchClass",
      c: "src.nope.missing.Thing",
      d: "1.2.3",
    }),
  });
  try {
    const g = await build(dir);
    const fromConfig = g.edges.filter((e) => e.source === "conf/x.json" && e.relation === "references");
    assert.deepEqual(fromConfig, [], "nothing in this config names anything the repo defines");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: a commented-out path in YAML/TOML is not wiring", async () => {
  const dir = makeFixture({ "conf/c.yaml": "# model: src.models.tfnet.TFNet\nmodel: other\n" });
  try {
    const g = await build(dir);
    assert.deepEqual(refsTo(g, "src/models/tfnet.py#TFNet"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: the file is indexed as a file node with no symbols", async () => {
  const dir = makeFixture({ "conf/train.json": JSON.stringify({ m: "src.models.tfnet.TFNet" }) });
  try {
    const g = await build(dir);
    const node = g.nodes.find((n) => n.id === "conf/train.json");
    assert.ok(node, "the config file is a node");
    assert.equal(node!.kind, "file");
    assert.equal(node!.origin, "config");
    assert.equal(
      g.nodes.filter((n) => n.path === "conf/train.json" && n.kind !== "file").length,
      0,
      "a config declares nothing, so it contributes no symbols",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("python: a dotted path in a string literal wires, a docstring does not", async () => {
  const dir = makeFixture({
    "settings.py": [
      '"""Configures src.models.tfnet.TFNet for the app."""',
      "",
      "INSTALLED_APPS = [",
      '    "src.models.tfnet.TFNet",',
      "]",
      "",
      "",
      "def loader():",
      '    """Loads src.models.tfnet.TFNet."""',
      '    return import_attr("src.models.tfnet.make_model")',
      "",
    ].join("\n"),
  });
  try {
    const g = await build(dir);
    assert.ok(
      refsTo(g, "src/models/tfnet.py#TFNet").includes("settings.py"),
      "a module-level list entry is wiring",
    );
    assert.ok(
      refsTo(g, "src/models/tfnet.py#make_model").includes("settings.py#loader"),
      "a dynamic-import argument is wiring",
    );
    // Both docstrings name TFNet too; neither may add an edge of its own.
    assert.ok(
      !refsTo(g, "src/models/tfnet.py#TFNet").includes("settings.py#loader"),
      "the function docstring must not wire its function to the class",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dottedPaths: shape rule and deduplication", () => {
  const found = dottedPaths(['a.b.C', 'a.b.C', 'x.y', '1.2.3', 'p.q.r.S'].join("\n"));
  assert.deepEqual(
    found.map((f) => f.path).sort(),
    ["a.b.C", "p.q.r.S"],
    "three-plus identifier segments only, each path once",
  );
  assert.equal(found.find((f) => f.path === "a.b.C")!.line, 1, "the first occurrence's line is kept");
});
