/**
 * Config tier: index the files that WIRE a repo together, not just the ones that
 * declare its symbols.
 *
 * A large class of projects selects its components by name from configuration —
 * `"model_name": "src.models.tfnet.TFNet"` in JSON, Hydra's `_target_` in YAML, a
 * Django `INSTALLED_APPS` entry, a Celery task path — and instantiates them
 * through `importlib`. The class is never written as code anywhere, so a purely
 * syntactic graph reports it as unused: `graft callers TFNet` says "no indexed
 * callers" for a class ninety configs select. The dependency is real and stated
 * in plain text; it just lives one file type away from the parser.
 *
 * This tier reads those files as TEXT rather than parsing each format. A dotted
 * path is the same token in JSON, YAML and TOML, quoted or bare, and scanning for
 * it needs no schema, no parser per format, and no knowledge of which key a given
 * framework uses. The safety comes from resolution, not from matching: an edge is
 * emitted only when the path names a module and symbol that actually exist in
 * this repo (see resolve.ts), so `torch.nn.Module`, a version string, or a dotted
 * word in prose all fall away by themselves.
 *
 * Config files contribute a file node and reference edges only — no symbols. A
 * config declares nothing; it points.
 */
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import type { NodeV1 } from "./types.js";
import type { RawEdge } from "./extract.js";

export interface ConfigLang {
  name: string;
  exts: readonly string[];
}

/** Formats whose values are plain enough that a dotted path means what it says.
 * Deliberately narrow: these are configuration formats, not data formats — a
 * `.csv` of user records has no wiring in it. */
export const CONFIG_LANGS: readonly ConfigLang[] = [
  { name: "json", exts: [".json"] },
  { name: "yaml", exts: [".yaml", ".yml"] },
  { name: "toml", exts: [".toml"] },
];

const EXT_TO_LANG = new Map<string, ConfigLang>();
for (const l of CONFIG_LANGS) for (const e of l.exts) EXT_TO_LANG.set(e, l);

export function configLangOf(path: string): ConfigLang | null {
  const i = path.lastIndexOf(".");
  if (i < 0) return null;
  return EXT_TO_LANG.get(path.slice(i).toLowerCase()) ?? null;
}

export function configExtensions(): string[] {
  return [...EXT_TO_LANG.keys()];
}

/**
 * A dotted path with at least three segments, each a valid identifier.
 *
 * Three, not two: `a.b` is overwhelmingly a filename, a version fragment or an
 * ordinary compound word, while `a.b.C` is the shape of a module path. Leading
 * digits are excluded, so `1.2.3` never matches. The trailing `\b` with a
 * non-`.` guard keeps a longer path from matching twice at different offsets.
 */
const DOTTED = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2,}\b(?!\.)/g;

/** Lines that are pure comment in these formats — a dotted path in one is not
 * wiring. JSON has no comments; YAML and TOML share `#`. */
const COMMENT = /^\s*[#]/;

/**
 * Every distinct dotted path in `source`, with the 1-based line it first
 * appears on. Deduplicated: a config naming one class in ten places states one
 * dependency, and ten identical edges would be collapsed by resolve anyway.
 */
export function dottedPaths(source: string): { path: string; line: number }[] {
  const seen = new Map<string, number>();
  const lines = source.split("\n");
  for (const [i, text] of lines.entries()) {
    if (COMMENT.test(text)) continue;
    for (const m of text.matchAll(DOTTED)) {
      if (!seen.has(m[0])) seen.set(m[0], i + 1);
    }
  }
  return [...seen].map(([path, line]) => ({ path, line }));
}

export function extractConfig(
  rel: string,
  source: string,
  lang: ConfigLang,
): { nodes: NodeV1[]; rawEdges: RawEdge[] } {
  const nodes: NodeV1[] = [
    {
      id: rel,
      name: basename(rel),
      kind: "file",
      path: rel,
      span: `L1-L${Math.max(1, source.split("\n").length)}`,
      signature: null,
      exported: true,
      origin: "config",
      body_hash: contentHash(source),
      chars: source.length,
      summary_state: "pending",
      summary: null,
      crux: null,
    } as NodeV1,
  ];
  const rawEdges: RawEdge[] = dottedPaths(source).map(({ path, line }) => ({
    source: rel,
    relation: "references" as const,
    name: path,
    dotted: true,
    file: rel,
    line,
  }));
  void lang;
  return { nodes, rawEdges };
}
