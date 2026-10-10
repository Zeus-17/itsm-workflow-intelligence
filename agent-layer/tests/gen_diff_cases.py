#!/usr/bin/env python3
"""
Generate differential test cases for the JavaScript schema validator (IDENTICAL COPY in both repos).

For every definition in the drafts / inputs / outputs schema documents it builds valid sample instances, then applies
deterministic single mutations (drop a key, wrong type, bad enum, extra property, out-of-range number, ...).  The
REFERENCE verdict for each instance comes from Python's `jsonschema`; run.js asserts the JavaScript validator agrees on
every one.  A disagreement means the mini validator is wrong - never "adjust the expected value".

Writes tests/diff-cases.json.
"""
import copy
import json
import os
import random
import re

from jsonschema import Draft202012Validator

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMAS = os.path.join(HERE, "..", "..", "schemas")


def load(name):
    with open(os.path.join(SCHEMAS, name), encoding="utf-8") as f:
        return json.load(f)


DOCS = {"drafts": load("agent-drafts.schema.json"), "inputs": load("engine-inputs.schema.json"), "outputs": load("engine-outputs.schema.json")}
with open(os.path.join(HERE, "..", "audit-schema.json"), encoding="utf-8") as _f:
    DOCS["audit"] = json.load(_f)


def resolve(doc, schema):
    while "$ref" in schema:
        schema = doc["$defs"][schema["$ref"].split("/")[-1]]
    return schema


def sample(doc, schema, prefer_computed=True):
    """Build ONE valid instance for a schema (first oneOf branch, minimal sizes)."""
    schema = resolve(doc, schema)
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][-1] if len(schema["enum"]) > 1 else schema["enum"][0]
    if "oneOf" in schema:
        return sample(doc, schema["oneOf"][0], prefer_computed)
    t = schema.get("type")
    if isinstance(t, list):  # nullable types: sample the non-null kind
        t = [x for x in t if x != "null"][0]
    if t == "object":
        out = {}
        for k, sub in schema.get("properties", {}).items():
            if k in schema.get("required", []):
                out[k] = sample(doc, sub, prefer_computed)
        return out
    if t == "array":
        n = schema.get("minItems", 0)
        if "items" in schema and (n or schema.get("items", {}).get("type") != "object"):
            return [sample(doc, schema["items"], prefer_computed) for _ in range(n)]
        return []
    if t == "string":
        if "pattern" in schema:
            for cand in ("", "2026-01-01T00:00:00Z", "2026-01-01"):  # first candidate that satisfies the pattern
                if re.search(schema["pattern"], cand):
                    return cand
        return "x" * schema.get("minLength", 1)
    if t == "integer":
        return int(schema.get("minimum", 0))
    if t == "number":
        return float(schema.get("minimum", 0))
    if t == "boolean":
        return True
    return None


def mutate(rng, inst):
    """Yield (label, mutated copy) pairs - a deterministic set of single mutations of `inst`."""
    out = []

    def walk(node, path):
        if isinstance(node, dict):
            for k in list(node):
                yield path + [k], node, k
                yield from walk(node[k], path + [k])
        elif isinstance(node, list):
            for i in range(len(node)):
                yield path + [i], node, i
                yield from walk(node[i], path + [i])

    sites = list(walk(inst, []))
    rng.shuffle(sites)
    for path, parent, key in sites[:14]:
        v = parent[key]
        for label, newv in (("wrong_type", [1, 2] if not isinstance(v, list) else "str"),
                            ("null", None),
                            ("number_out", (v + 1000) if isinstance(v, int) and not isinstance(v, bool) else None),
                            ("bad_enum", "ZZ-not-a-value" if isinstance(v, str) else None),
                            ("neg", -5 if isinstance(v, int) and not isinstance(v, bool) else None)):
            if newv is None and label != "null":
                continue
            m = copy.deepcopy(inst)
            cur = m
            for p in path[:-1]:
                cur = cur[p]
            cur[path[-1]] = newv
            out.append((f"{label}@{'/'.join(map(str, path))}", m))
        if isinstance(parent, dict):
            m = copy.deepcopy(inst)
            cur = m
            for p in path[:-1]:
                cur = cur[p]
            del cur[path[-1]]
            out.append((f"drop@{'/'.join(map(str, path))}", m))
    if isinstance(inst, dict):
        m = copy.deepcopy(inst)
        m["unexpected_extra_key"] = 1
        out.append(("extra_key@root", m))
    out.append(("not_object", "string-instead"))
    out.append(("empty_object", {}))
    return out


def main():
    rng = random.Random(20261010)
    cases = []
    for docname, doc in DOCS.items():
        for defname in doc["$defs"]:
            if defname in ("Provenance", "UnresolvedReason", "Unresolved", "Caveat", "MissingInput"):
                continue
            validator = Draft202012Validator({"$schema": doc["$schema"], "$defs": doc["$defs"], "$ref": f"#/$defs/{defname}"})
            base = sample(doc, {"$ref": f"#/$defs/{defname}"})
            insts = [("base", base)] + mutate(rng, base)
            # outputs: exercise if/then (completeness) explicitly when the computed branch has it
            if docname == "outputs":
                comp = doc["$defs"][defname]["oneOf"][0]
                if "if" in comp:
                    for complete in (True, False):
                        inst = copy.deepcopy(base)
                        inst["caveats"] = [{"code": "c", "field": "f"}]
                        inst["output"]["complete"] = complete
                        insts.append((f"caveat_complete_{complete}", inst))
                    inst = copy.deepcopy(base)
                    inst["caveats"] = []
                    inst["output"]["complete"] = True
                    insts.append(("nocaveat_complete_true", inst))
                for st in ("cannot_be_determined", "not_assessed"):
                    insts.append((f"{st}_ok", {"engine": defname, "status": st, "missing": [{"field": "f", "reason_code": "r"}]}))
                    insts.append((f"{st}_empty_missing", {"engine": defname, "status": st, "missing": []}))
                    insts.append((f"{st}_with_output", {"engine": defname, "status": st, "output": {}, "missing": [{"field": "f", "reason_code": "r"}]}))
            for label, inst in insts:
                cases.append({"doc": docname, "def": defname, "label": label, "instance": inst, "valid": validator.is_valid(inst)})
    # uniqueItems: for every top-level array property that declares it, a duplicated and a single-element list
    for defname, d in DOCS["inputs"]["$defs"].items():
        for prop, sub in d.get("properties", {}).items():
            if sub.get("type") == "array" and sub.get("uniqueItems") and "enum" in sub.get("items", {}):
                e0 = sub["items"]["enum"][0]
                for label, lst in (("unique_single", [e0]), ("unique_duplicate", [e0, e0])):
                    inp = sample(DOCS["inputs"], {"$ref": f"#/$defs/{defname}"})
                    inp[prop] = lst
                    dr = sample(DOCS["drafts"], {"$ref": f"#/$defs/{defname}"})
                    dr[prop] = {"state": "resolved", "value": lst, "provenance": "form"}
                    for docname, inst in (("inputs", inp), ("drafts", dr)):
                        v = Draft202012Validator({"$schema": DOCS[docname]["$schema"], "$defs": DOCS[docname]["$defs"], "$ref": f"#/$defs/{defname}"})
                        cases.append({"doc": docname, "def": defname, "label": f"{label}@{prop}", "instance": inst, "valid": v.is_valid(inst)})
    with open(os.path.join(HERE, "diff-cases.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"cases": cases}, f, ensure_ascii=False)
        f.write("\n")
    nvalid = sum(c["valid"] for c in cases)
    print(f"wrote {len(cases)} differential cases ({nvalid} valid / {len(cases) - nvalid} invalid)")


if __name__ == "__main__":
    main()
