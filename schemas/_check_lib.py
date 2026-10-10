"""
Shared verification library for the schema package (IDENTICAL COPY in both repos; hash-locked via COMMON.sha256).

`run_checks(here, build_module, tool, check_outputs)` performs the Step 2 gate:
  1. every schema file is valid JSON Schema 2020-12
  2. _common.py and _check_lib.py match the recorded hashes (RM and ITSM copies must stay identical)
  3. DRIFT: regenerating from the tool source gives byte-identical committed files
  4. POLICY COMPLETENESS: every leaf input path of every engine has an unresolved-policy entry (and vice versa)
  5. FALLBACK VALIDITY: every fallback value is valid for its field and carries a caveat code
  6. CONFORMANCE: the reference Resolver reproduces every expected outcome in fixtures/policy-cases.json
  7. OUTPUT FIT: tool-specific callback validates recorded real engine outputs against the output schemas

The Resolver is a specification-by-example for the Step 3 validation layer (JavaScript), which must pass the same cases.
"""
import copy
import json
import os
import re

from jsonschema import Draft202012Validator

from _common import leaf_paths, sha256_file

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("  FAIL:", msg)
    return cond


def norm(path):
    """gates[2].status -> gates[].status"""
    return re.sub(r"\[\d+\]", "[]", path)


def get_at(obj, path):
    cur = obj
    for tok in re.findall(r"[A-Za-z_]+|\[\d+\]", path):
        cur = cur[int(tok[1:-1])] if tok.startswith("[") else cur[tok]
    return cur


def validator(doc, engine):
    return Draft202012Validator({"$schema": doc["$schema"], "$defs": doc["$defs"], "$ref": f"#/$defs/{engine}"})


class Resolver:
    """Turns an agent DRAFT into either an engine-ready input or an explicit non-answer."""

    def __init__(self, inputs, drafts, policy):
        self.inputs, self.drafts, self.policy = inputs, drafts, policy

    def resolve(self, engine, draft, agent_supplied=()):
        eng_pol = self.policy["engines"][engine]
        pol = eng_pol["inputs"]
        # 0. fields the agent may never write (e.g. the GO/NO-GO decision, the severity pick)
        for path in agent_supplied:
            if pol.get(path, {}).get("agent_writable") == "no":
                return {"status": "rejected", "reason": f"agent_may_not_write:{path}"}
        # 1. the draft must be well-formed: every field explicit, provenance trustworthy, types/enums right
        if list(validator(self.drafts, engine).iter_errors(draft)):
            return {"status": "rejected", "reason": "malformed_draft"}
        # 2. walk the draft: substitute named fallbacks, collect blocks and caveats
        missing, caveats = [], []
        value = self._walk(draft, self.inputs["$defs"][engine], "", pol, missing, caveats)
        if missing:
            return self._missing_result(missing)
        # 3. the resulting engine input must satisfy the strict input schema
        ierrs = list(validator(self.inputs, engine).iter_errors(value))
        if ierrs:
            miss = []
            for e in ierrs:
                p = norm(self._err_path(e))
                entry = self._lookup(pol, p)
                if entry and entry.get("on_invalid") == "block_as_missing":
                    miss.append({"field": p, "reason_code": entry["reason_code"], "_status": entry["block_status"]})
                elif entry and entry.get("on_invalid") == "not_assessed":
                    miss.append({"field": p, "reason_code": entry.get("invalid_reason_code", entry["reason_code"]), "_status": "not_assessed"})
                else:
                    return {"status": "rejected", "reason": "engine_input_invalid"}
            return self._missing_result(miss)
        # 4. engine-level sufficiency: "at least one of these must carry real content"
        for rule in eng_pol.get("_engine", {}).get("requires_any_of", []):
            if not any(self._nonblank(get_at(value, f)) for f in rule["fields"]):
                return {"status": rule["status"], "missing": [{"field": "+".join(rule["fields"]), "reason_code": rule["reason_code"]}]}
        return {"status": "ready", "engine_input": value, "caveats": caveats}

    # -- helpers
    @staticmethod
    def _nonblank(v):
        return bool(v.strip()) if isinstance(v, str) else bool(v)

    @staticmethod
    def _err_path(e):
        out = ""
        for part in e.absolute_path:
            out += f"[{part}]" if isinstance(part, int) else (("." if out else "") + str(part))
        return out

    @staticmethod
    def _lookup(pol, path):
        while path:
            if path in pol:
                return pol[path]
            path = re.sub(r"(\[\]|\.[A-Za-z_]+)$", "", path)
        return None

    @staticmethod
    def _missing_result(missing):
        status = "cannot_be_determined" if any(m.get("_status", "cannot_be_determined") == "cannot_be_determined" for m in missing) else "not_assessed"
        return {"status": status, "missing": [{"field": m["field"], "reason_code": m["reason_code"]} for m in missing]}

    def _walk(self, node, schema, path, pol, missing, caveats):
        is_obj = schema.get("type") == "object" and "properties" in schema
        is_arr_obj = schema.get("type") == "array" and schema.get("items", {}).get("type") == "object" and "properties" in schema.get("items", {})
        if is_obj:
            return {k: self._walk(node[k], sub, f"{path}.{k}" if path else k, pol, missing, caveats) for k, sub in schema["properties"].items()}
        if is_arr_obj:
            if isinstance(node, dict) and node.get("state") == "unresolved":
                return self._apply(pol, path, norm(path), missing, caveats)
            return [self._walk(el, schema["items"], f"{path}[{i}]", pol, missing, caveats) for i, el in enumerate(node)]
        if node["state"] == "resolved":
            return node["value"]
        return self._apply(pol, path, norm(path), missing, caveats)

    @staticmethod
    def _apply(pol, display, key, missing, caveats):
        entry = pol[key]
        if entry["on_unresolved"] == "block":
            missing.append({"field": display, "reason_code": entry["reason_code"], "_status": entry["block_status"]})
            return None
        caveats.append({"code": entry["caveat_code"], "field": display})
        return copy.deepcopy(entry["fallback_value"])


def run_checks(here, build_module, tool, check_outputs):
    def load(*parts):
        with open(os.path.join(here, *parts), encoding="utf-8") as f:
            return json.load(f)

    print(f"Checking {tool.upper()} schema package")
    files = ["engine-inputs.schema.json", "agent-drafts.schema.json", "engine-outputs.schema.json"]
    inputs, drafts, outputs = (load(f) for f in files)
    policy = load("unresolved-policy.json")

    print("1. valid JSON Schema")
    for f, doc in zip(files, (inputs, drafts, outputs)):
        try:
            Draft202012Validator.check_schema(doc)
        except Exception as ex:  # noqa: BLE001
            check(False, f"{f} is not a valid schema: {ex}")

    print("2. shared module hashes")
    recorded = {}
    for line in open(os.path.join(here, "COMMON.sha256"), encoding="utf-8").read().splitlines():
        h, name = line.split()
        recorded[name] = h
    for name in ("_common.py", "_check_lib.py"):
        check(recorded.get(name) == sha256_file(os.path.join(here, name)),
              f"{name} differs from COMMON.sha256 (copies in both repos must be identical; re-run build_schemas.py)")

    print("3. drift vs tool source")
    for name, obj in build_module.generate().items():
        check(load(name) == json.loads(json.dumps(obj)), f"{name} is out of date relative to the tool source or generator (run build_schemas.py and review the diff)")

    print("4. policy completeness")
    for eng, schema in inputs["$defs"].items():
        paths = set(leaf_paths(schema))
        pol_paths = {p for p in policy["engines"][eng]["inputs"]}
        check(paths == pol_paths, f"{eng}: policy mismatch. uncovered={sorted(paths - pol_paths)} unknown={sorted(pol_paths - paths)}")
        for rule in policy["engines"][eng].get("_engine", {}).get("requires_any_of", []):
            check(all(f in paths for f in rule["fields"]), f"{eng}: requires_any_of names an unknown field {rule['fields']}")

    print("5. fallback values valid for their fields")
    for eng, ent in policy["engines"].items():
        for path, e in ent["inputs"].items():
            if e["on_unresolved"] != "fallback":
                continue
            leaf = inputs["$defs"][eng]
            for tok in re.findall(r"[A-Za-z_]+|\[\]", path):
                leaf = leaf["items"] if tok == "[]" else leaf["properties"][tok]
            sub = {k: v for k, v in leaf.items() if k not in ("minItems", "minLength")}  # sufficiency is the policy's job
            check(Draft202012Validator(sub).is_valid(e["fallback_value"]), f"{eng}.{path}: fallback {e['fallback_value']!r} is not valid for the field")
            check(bool(e.get("caveat_code")), f"{eng}.{path}: fallback without a caveat code")

    print("6. conformance cases (reference resolver)")
    res = Resolver(inputs, drafts, policy)
    cases = load("fixtures", "policy-cases.json")["cases"]
    for c in cases:
        got = res.resolve(c["engine"], c["draft"], c.get("agent_supplied", ()))
        exp = c["expect"]
        ok = got["status"] == exp["status"]
        if ok and "missing" in exp:
            ok = got.get("missing") == exp["missing"]
        if ok and "caveats" in exp:
            ok = got.get("caveats") == exp["caveats"]
        if ok and "engine_input_contains" in exp:
            ok = all(get_at(got["engine_input"], p) == v for p, v in exp["engine_input_contains"].items())
        if ok and "reason" in exp:
            ok = got.get("reason") == exp["reason"]
        check(ok, f"case {c['id']}: expected {exp}, got {json.dumps(got)[:300]}")
    print(f"   {len(cases)} cases")

    print("7. output schemas fit recorded engine outputs")
    check_outputs(outputs, check)

    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} problem(s)")
        return 1
    print("ALL CHECKS PASSED")
    return 0
