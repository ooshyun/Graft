/**
 * Tests for Python constructor call edges in the Tier-1 code graph.
 *
 * Python spells construction as an ordinary call — `Widget()`, with no `new` to
 * mark it — so a constructor edge reaches the resolver indistinguishable from a
 * function call. Resolved against the function-only index it vanishes, and
 * `graft callers <SomeClass>` reports "no indexed callers" on a class every file
 * in the repo instantiates. That is the same failure `graph-java.test.ts` pins
 * for `new Foo()`, in the language where it is invisible.
 *
 * The fix is a fallback, not a swap: unlike Java, Python HAS free functions, so
 * resolving bare calls against types outright would trade real function edges
 * away. Functions are matched first and unchanged; types are tried only when
 * that finds nothing.
 *
 * The last two tests pin that ordering and the drop rule, because a fallback
 * that fires too eagerly is worse than the missing edge. Both are written as
 * negative assertions — bare-call resolution does not read import bindings
 * today, so pinning which target it picks would freeze that limitation into the
 * suite. What must hold under any implementation is that the fallback stays
 * silent while a function matches, and never guesses between two same-named
 * classes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const THING = `class Widget:
    def run(self):
        return 1


def helper():
    return 2
`;

const MAIN = `from pkg.thing import Widget, helper


def build():
    w = Widget()
    return w.run() + helper()
`;

/** `Thing` is a function here and a class in `dup_class.py` — the function must win. */
const DUAL_FN = `def Thing():
    return 1
`;

const DUAL_CLASS = `class Thing:
    pass
`;

/** `Dup` is a class in two files. `dup_a.py` is the copy `caller.py` does NOT
 * import, and it sorts first — so an implementation that takes the first global
 * candidate instead of requiring a unique one picks it, and test 4 catches that. */
const DUP_A = `class Dup:
    pass
`;

const DUP_B = `class Dup:
    pass
`;

const CALLER = `from dual_fn import Thing
from dup_z import Dup


def use_thing():
    return Thing()


def use_dup():
    return Dup()
`;

/** Construction in the file that declares the class — a same-file, `extracted` edge. */
const LOCAL = `class Local:
    pass


def make():
    return Local()
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-python-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "");
  writeFileSync(join(dir, "pkg", "thing.py"), THING);
  writeFileSync(join(dir, "main.py"), MAIN);
  writeFileSync(join(dir, "dual_fn.py"), DUAL_FN);
  writeFileSync(join(dir, "dup_class.py"), DUAL_CLASS);
  writeFileSync(join(dir, "dup_a.py"), DUP_A);
  writeFileSync(join(dir, "dup_z.py"), DUP_B);
  writeFileSync(join(dir, "caller.py"), CALLER);
  writeFileSync(join(dir, "local.py"), LOCAL);
  return dir;
}

async function buildFixture(dir: string): Promise<GraphV1> {
  await buildGraph(dir); // $0, Tier-1 only
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!;
}

test("Python: `Widget()` produces a constructor edge to the class", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const calls = graph.edges.filter((e) => e.relation === "calls");

    assert.ok(
      calls.some((e) => e.source === "main.py#build" && e.target === "pkg/thing.py#Widget"),
      "build should have a constructor edge to Widget",
    );

    // The existing function path is untouched: a plain call still resolves.
    assert.ok(
      calls.some((e) => e.source === "main.py#build" && e.target === "pkg/thing.py#helper"),
      "build should still call helper",
    );

    // And the receiver bound by `w = Widget()` still reaches the method.
    assert.ok(
      calls.some((e) => e.source === "main.py#build" && e.target === "pkg/thing.py#Widget.run"),
      "build should call Widget.run through the constructor-assigned receiver",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: same-file construction resolves as an extracted edge", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const edge = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "local.py#make" && e.target === "local.py#Local",
    );
    assert.ok(edge, "make should have a constructor edge to Local");
    assert.equal(edge!.confidence, "extracted", "a same-file target is certain, not inferred");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: the fallback stays silent when a function of that name matches", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const targets = graph.edges
      .filter((e) => e.relation === "calls" && e.source === "caller.py#use_thing")
      .map((e) => e.target);

    // `caller.py` imports the FUNCTION `Thing`, and a function match means the
    // fallback never runs — so the class of the same name must not be linked.
    assert.ok(targets.includes("dual_fn.py#Thing"), "Thing() should resolve to the imported function");
    assert.ok(
      !targets.includes("dup_class.py#Thing"),
      "the same-named class must not be linked — the fallback fires only when no function matches",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: an ambiguous class name is never guessed at", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const targets = graph.edges
      .filter((e) => e.relation === "calls" && e.source === "caller.py#use_dup")
      .map((e) => e.target);

    // `Dup` is declared in two files. Today resolveName finds two global
    // candidates and drops, which is correct-by-omission; an import-aware
    // resolver would instead pick `dup_z`, the one `caller.py` imports. Both are
    // acceptable — picking `dup_a`, the one it does not import, never is.
    assert.ok(
      !targets.includes("dup_a.py#Dup"),
      "a class the caller never imported must never be guessed at",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a same-named class resolves to the module it was imported from", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const edge = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "caller.py#use_dup" && e.target === "dup_z.py#Dup",
    );
    // `Dup` is defined in dup_a.py and dup_z.py; `caller.py` imports dup_z's.
    // The import names both halves — module and exported name — so the target
    // is stated, not guessed, and the repo-wide ambiguity never arises.
    assert.ok(edge, "Dup() should resolve to dup_z, the module caller.py imports");
    assert.equal(edge!.confidence, "extracted", "an import-named target is certain, not inferred");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: an aliased import resolves under its local alias", async () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "aliased.py"), "from dup_z import Dup as Renamed\n\n\ndef use():\n    return Renamed()\n");
    const graph = await buildFixture(dir);
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "aliased.py#use" && e.target === "dup_z.py#Dup",
      ),
      "Renamed() should resolve to the aliased class's real definition",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a package-relative import resolves against the importing file's package", async () => {
  const dir = makeFixture();
  try {
    // `pkg/sibling.py` imports from `pkg/thing.py` with a single leading dot.
    writeFileSync(
      join(dir, "pkg", "sibling.py"),
      "from .thing import Widget\n\n\ndef make():\n    return Widget()\n",
    );
    const graph = await buildFixture(dir);
    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "calls" && e.source === "pkg/sibling.py#make" && e.target === "pkg/thing.py#Widget",
      ),
      "`from .thing import Widget` should resolve to the sibling module in the same package",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a call edge records the line of the call, not of a mention above it", async () => {
  const dir = makeFixture();
  try {
    // A docstring and a comment both name `Widget` before the real call, which is
    // what a name-search for the evidence line would find first.
    writeFileSync(
      join(dir, "quoted.py"),
      [
        "from pkg.thing import Widget",
        "",
        "",
        "def make():",
        '    """Build a Widget for the caller."""',
        "    # Widget is constructed below",
        "    return Widget()",
        "",
      ].join("\n"),
    );
    const graph = await buildFixture(dir);
    const edge = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "quoted.py#make" && e.target === "pkg/thing.py#Widget",
    );
    assert.ok(edge, "make should call Widget");
    assert.equal(edge!.line, 7, "the recorded line is the call, not the docstring (5) or comment (6)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a bare call with no import naming it still drops when ambiguous", async () => {
  const dir = makeFixture();
  try {
    // No import at all: the call site states only a name two files define, so
    // there is nothing to resolve against and the drop rule stands.
    writeFileSync(join(dir, "noimport.py"), "def use():\n    return Dup()\n");
    const graph = await buildFixture(dir);
    const targets = graph.edges
      .filter((e) => e.relation === "calls" && e.source === "noimport.py#use")
      .map((e) => e.target);
    assert.deepEqual(targets, [], "an unimported ambiguous name must stay unresolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Calls through a stored instance (F2). `self.film(x)` where
 * `self.film = FiLM(...)` is not a method call — the name is a field — so the
 * owner-qualified lookup finds nothing and the edge used to be dropped, even
 * though the binding table already knew the type. These pin the fallback and
 * the two ways it must NOT fire.
 */

const INSTANCE_FIELD = `import torch.nn as nn

from pkg.thing import Widget


class Holder:
    def __init__(self, n):
        self.w = Widget()
        self.layers = [Widget(), Widget()]
        self.mods = nn.ModuleDict({f"k{i}": Widget() for i in range(n)})
        self.mixed = [Widget(), object()]

    def run(self):
        return self.w()

    def run_indexed(self, i):
        return self.layers[i]()

    def run_dict(self, k):
        return self.mods[k]()

    def run_mixed(self, i):
        return self.mixed[i]()

    def keys(self):
        return self.layers.keys()
`;

/** A class with BOTH a field and a method of one name — the method must win. */
const FIELD_VS_METHOD = `from pkg.thing import Widget


class Both:
    def __init__(self):
        self.run = Widget()

    def run(self):
        return 1

    def go(self):
        return self.run()
`;

test("Python: calling a bound instance field resolves to the field's class", async () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "holder.py"), INSTANCE_FIELD);
    const graph = await buildFixture(dir);
    const calls = graph.edges.filter((e) => e.relation === "calls");
    assert.ok(
      calls.some((e) => e.source === "holder.py#Holder.run" && e.target === "pkg/thing.py#Widget"),
      "self.w() should reach Widget, the type self.w was constructed from",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a subscripted call resolves through the container's element type", async () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "holder.py"), INSTANCE_FIELD);
    const graph = await buildFixture(dir);
    const calls = graph.edges.filter((e) => e.relation === "calls");
    assert.ok(
      calls.some((e) => e.source === "holder.py#Holder.run_indexed" && e.target === "pkg/thing.py#Widget"),
      "self.layers[i]() should reach Widget through the homogeneous container",
    );
    assert.ok(
      calls.some((e) => e.source === "holder.py#Holder.run_dict" && e.target === "pkg/thing.py#Widget"),
      "a dict comprehension inside a container constructor types its values too",
    );
    // A heterogeneous container has no single element type — nothing to resolve.
    assert.ok(
      !calls.some((e) => e.source === "holder.py#Holder.run_mixed" && e.target === "pkg/thing.py#Widget"),
      "a mixed container must not be typed by its first element",
    );
    // The element type is kept under its own key, so an ordinary attribute call
    // on the container itself cannot pick it up.
    assert.ok(
      !calls.some((e) => e.source === "holder.py#Holder.keys" && e.target === "pkg/thing.py#Widget"),
      "self.layers.keys() is a call on the container, not on an element",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a field assigned on both arms of a branch reaches both types", async () => {
  const dir = makeFixture();
  try {
    writeFileSync(
      join(dir, "either.py"),
      [
        "from pkg.thing import Widget",
        "from dup_z import Dup",
        "",
        "",
        "class Either:",
        "    def __init__(self, flag):",
        "        if flag:",
        "            self.impl = Widget()",
        "        else:",
        "            self.impl = Dup()",
        "",
        "    def run(self):",
        "        return self.impl()",
        "",
      ].join("\n"),
    );
    const graph = await buildFixture(dir);
    const targets = graph.edges
      .filter((e) => e.relation === "calls" && e.source === "either.py#Either.run")
      .map((e) => e.target);
    // Both assignments are in the source; the field really can hold either, so
    // naming only the last would be a silent choice between two true answers.
    assert.ok(targets.includes("pkg/thing.py#Widget"), "the if-arm's type is reached");
    assert.ok(targets.includes("dup_z.py#Dup"), "the else-arm's type is reached too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a real method outranks a same-named instance field", async () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "both.py"), FIELD_VS_METHOD);
    const graph = await buildFixture(dir);
    const targets = graph.edges
      .filter((e) => e.relation === "calls" && e.source === "both.py#Both.go")
      .map((e) => e.target);
    assert.ok(targets.some((t) => t.startsWith("both.py#Both.run")), "self.run() resolves to the method");
    assert.ok(
      !targets.includes("pkg/thing.py#Widget"),
      "the field fallback must not fire while a method of that name matches",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
