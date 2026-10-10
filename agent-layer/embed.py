#!/usr/bin/env python3
"""
Embed the agent layer (validation + audit + failsafe [+ the tool's own engine exports]) into the tool's single HTML file (Build Brief Steps 3-4).

IDENTICAL COPY in both repos (hash-locked by LOCK.sha256).  Reads:
    validation.js, audit.js, failsafe.js, audit-schema.json   the shared modules / log schema
    engine-exports.js                              OPTIONAL, per tool (config.json "engineExports"): read-only pure versions of the tool's engines
    config.json                                    per tool: html path, labels, engine sources, versions
    ../schemas/*.json                              engine inputs / drafts / outputs / unresolved policy (Step 2)
and writes ONE block into the tool HTML, immediately before the final </body>:

    <!-- AGENT-LAYER:BEGIN ... --> <script id="agent-layer"> ... </script> <!-- AGENT-LAYER:END -->

The block is purely additive: it defines window.AgentLayer, window.AgentAudit, window.AgentFailsafe (and window.AgentEngine when present) and nothing else, references no existing
function or element by CALLING it, writes nothing to storage until the agent layer is actually used, and does nothing
until something calls it. The tool behaves identically with it present.

`engineSources` in config.json is a list of plain JavaScript IDENTIFIERS (rule tables / engine functions). They are
validated against a strict pattern here and emitted as static `try { s.push(NAME) } catch` statements - there is no eval and
no dynamic code. Their source/content is hashed at run time to fingerprint the deterministic engine.

    python agent-layer/embed.py            # (re)generate the block in place
    python agent-layer/embed.py --check    # exit 1 if the block in the HTML is stale or hand-edited
    python agent-layer/embed.py --remove   # take the block out again (rollback helper)
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BEGIN_RE = re.compile(r"<!-- AGENT-LAYER:BEGIN[^>]*-->")
END = "<!-- AGENT-LAYER:END -->"
IDENT = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]{0,60}$")


def read(path):
    with io.open(path, encoding="utf-8", newline=None) as f:   # universal newlines -> '\n'
        return f.read()


def atomic_write(path, text, retries=6):
    """
    Write `text` to `path` so that a failure can never leave a truncated tool file: write a temp file next to it, then replace.
    Retries briefly because on Windows a file that a local preview server or editor has just read can be momentarily locked.
    """
    import time
    tmp = path + ".agentlayer.tmp"
    last = None
    for i in range(retries):
        try:
            with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.replace(tmp, path)
            return
        except OSError as e:          # noqa: PERF203
            last = e
            time.sleep(0.4 * (i + 1))
    try:
        if os.path.exists(tmp):
            os.remove(tmp)
    except OSError:
        pass
    raise last


def js_json(obj):
    """JSON safe to place inside a <script> element: '</' and '<!--' can never terminate or confuse the script."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/").replace("<!--", "<\\!--")


def compact(src):
    """
    Shrink a module for embedding by removing documentation the browser does not need. The repo source stays fully commented;
    only the EMBEDDED copy is compacted.  Deliberately conservative and tied to this codebase's formatting:
      * whole-line  // comments and  /* ... */ blocks that START a line are removed
      * a /*! ... */ banner is replaced by a one-line banner pointing back to the source
      * trailing comments after code, strings and regexes are never touched
    The embedded artifact is then tested as shipped (tests/artifact_run.js), so a bad strip cannot go unnoticed.
    """
    out, inblk, banner = [], False, None
    for ln in src.split("\n"):
        t = ln.strip()
        if inblk:
            if "*/" in t:
                inblk = False
            continue
        if t.startswith("/*"):
            if t.startswith("/*!"):
                banner = banner or t[3:].strip(" *")
                if "*/" not in t:
                    inblk = True
                continue
            if "*/" not in t:
                inblk = True
            continue
        if t.startswith("//"):
            continue
        if t:
            out.append(ln.rstrip())
    head = f"/*! {banner} - documented source: agent-layer/ in the repository */" if banner else ""
    return (head + "\n" if head else "") + "\n".join(out)


def module_source(name, strip=True):
    src = read(os.path.join(HERE, name)).rstrip()
    assert "</script" not in src.lower(), f"{name} must not contain a script terminator"
    assert "AGENT-LAYER:" not in src, f"{name} must not contain the block marker text"
    return compact(src) if strip else src


def build_block(cfg):
    schemas = {}
    for key, fname in (("inputs", "engine-inputs.schema.json"), ("drafts", "agent-drafts.schema.json"),
                       ("outputs", "engine-outputs.schema.json"), ("policy", "unresolved-policy.json")):
        with io.open(os.path.join(HERE, "..", "schemas", fname), encoding="utf-8") as f:
            schemas[key] = json.load(f)
    with io.open(os.path.join(HERE, "audit-schema.json"), encoding="utf-8") as f:
        audit_schema = json.load(f)
    strip = cfg.get("stripComments", True)
    validation, audit, failsafe = module_source("validation.js", strip), module_source("audit.js", strip), module_source("failsafe.js", strip)
    engine_file = cfg.get("engineExports")
    if engine_file:
        assert re.match(r"^[A-Za-z0-9_.-]+\.js$", engine_file), f"engineExports must be a plain file name: {engine_file!r}"
        engine_exports = module_source(engine_file, strip)
    else:
        engine_exports = ""
    version = re.search(r"var VERSION = '([^']+)'", validation).group(1)
    sources = cfg.get("engineSources", [])
    for ident in sources:
        assert IDENT.match(ident), f"engineSources entry is not a plain identifier: {ident!r}"
    push = "".join(f"try {{ s.push({i}); }} catch (e) {{ s.push(null); }} " for i in sources)
    audit_cfg = {"tool": cfg["tool"], "toolVersion": cfg["toolVersion"], "engineVersion": cfg["engineVersion"],
                 "deployedTag": cfg["deployedTag"], "exportHints": cfg["exportHints"], "schema": audit_schema}
    nl = "\n"
    boot_validation = f"window.AgentLayer.configure({js_json({'tool': cfg['tool'], 'paymentLabel': cfg['paymentLabel'], 'schemas': schemas})});"
    boot_audit = (f"var __a = {js_json(audit_cfg)}; __a.validate = window.AgentLayer.validate.instance; "
                  f"__a.engineSources = function () {{ var s = []; {push}return s; }}; "
                  f"window.AgentAudit.init(__a); window.AgentAudit.log().bridge(window.AgentLayer); "
                  f"window.AgentFailsafe.init({{ tool: {js_json(cfg['tool'])}, audit: window.AgentAudit.log(), redact: window.AgentLayer.prefilter.redactPii }});")
    return (f"<!-- AGENT-LAYER:BEGIN v{version} (generated by agent-layer/embed.py; do not edit by hand) -->{nl}"
            f'<script id="agent-layer">{nl}{validation}{nl}{audit}{nl}{failsafe}{nl}{engine_exports + nl if engine_exports else ""}'
            f";(function(){{ try {{ {boot_validation} {boot_audit} }} "
            f"catch (e) {{ if (window.console) console.error('AgentLayer configuration failed', e); }} }})();{nl}"
            f"</script>{nl}{END}{nl}")


def main(argv):
    cfg = json.load(io.open(os.path.join(HERE, "config.json"), encoding="utf-8"))
    html_path = os.path.normpath(os.path.join(HERE, cfg["html"]))
    html = read(html_path)
    m = BEGIN_RE.search(html)
    has_block = m is not None
    if "--remove" in argv:
        if has_block:
            end = html.rindex(END) + len(END)
            html = html[: m.start()] + html[end:].lstrip("\n")
            atomic_write(html_path, html)
        print("removed agent-layer block" if has_block else "no block present")
        return 0
    block = build_block(cfg)
    if has_block:
        end = html.rindex(END) + len(END)
        current = html[m.start(): end] + "\n"
        new_html = html[: m.start()] + block + html[end:].lstrip("\n")
    else:
        idx = html.rfind("</body>")
        assert idx > 0, "no </body> found"
        current = None
        new_html = html[:idx] + block + html[idx:]
    if "--check" in argv:
        ok = has_block and current == block
        print("agent-layer block is up to date" if ok else "agent-layer block is MISSING or STALE (run embed.py)")
        return 0 if ok else 1
    atomic_write(html_path, new_html)
    print(f"embedded agent layer into {os.path.basename(html_path)} ({len(block)//1024} KB block)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
