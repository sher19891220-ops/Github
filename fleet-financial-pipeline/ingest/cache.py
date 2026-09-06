"""A disk cache for the parsers that read source documents.

WHY THIS EXISTS, MEASURED. Every module here re-parses the original documents on
every call, and the originals are slow to read:

    load_ifta()                177 PDFs, text layer          126.0s
    parse_oregon.load()        23 scans, OCR at 200 dpi       94.5s
    fleet_registry.registry()  a 1,413-row workbook           22.5s
    one P&L workbook            27 tabs of openpyxl            9.3s

A single `cost_structure.py --explain` touches all of them and takes about five
minutes; the test suite touches them from a dozen modules and takes fourteen.
None of that work is different the second time.

INVALIDATION IS THE WHOLE DESIGN. A cache that answers with stale numbers is
worse than no cache at all -- this pipeline exists to be right, not fast. So the
key is built from the INPUT FILES themselves: their paths, sizes and modification
times. Re-upload a document after a container reclaim and every one of those
changes, so the entry misses and the parser runs. Add a new return to a
directory and the file list changes, so it misses. There is no manual
"remember to clear the cache" step, because a step like that is always forgotten
exactly once and then believed for a week.

JSON, NOT PICKLE. The payloads are dicts of numbers and strings, so JSON carries
them, and a cache directory that cannot execute code on load is one less thing to
reason about in a repo that handles financial records. A payload JSON cannot
round-trip must not be cached here.

THE CACHE IS DERIVED DATA AND IS GITIGNORED. It rebuilds itself from the corpus;
losing it costs time and nothing else.
"""
import functools
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data/cache"
# Bump when a parser's OUTPUT SHAPE changes in a way older entries would not
# carry. A code change that alters what a parser returns is not visible in the
# input files, so it is the one invalidation this cannot infer.
VERSION = "1"
DISABLE = os.environ.get("FLEET_NO_CACHE") == "1"


def fingerprint(paths):
    """Identity of a set of input files: path, size, mtime.

    Not a content hash: hashing 177 PDFs on every call costs more than it saves,
    and size+mtime already changes on every re-upload, edit and re-extraction.
    The catalog keys on content hash because it must recognise the SAME document
    under two paths; this must only notice that something changed.
    """
    h = hashlib.sha256()
    for p in sorted(str(x) for x in paths):
        try:
            st = os.stat(p)
            h.update(f"{p}|{st.st_size}|{st.st_mtime_ns}".encode())
        except OSError:
            h.update(f"{p}|MISSING".encode())
    return h.hexdigest()[:20]


def cached(name, inputs):
    """Cache a parser's result against the files it reads.

    `inputs` is a callable returning the paths the function will read, evaluated
    at call time -- so a directory that gained a file since import is seen. It
    may take the call's own arguments, for a parser whose input IS an argument:
    a per-workbook reader keyed only on its argument string would never notice
    that the workbook itself had been re-uploaded.
    """
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if DISABLE:
                return fn(*args, **kwargs)
            try:
                try:
                    paths = inputs(*args, **kwargs)
                except TypeError:
                    paths = inputs()
                key = f"{name}-{VERSION}-{fingerprint(paths)}"
                if args or kwargs:
                    key += "-" + hashlib.sha256(
                        repr((args, sorted(kwargs.items()))).encode()).hexdigest()[:10]
                path = CACHE_DIR / f"{key}.json"
                if path.exists():
                    return json.loads(path.read_text())
            except Exception as exc:            # a broken cache never blocks work
                print(f"cache read failed for {name}: {exc}", file=sys.stderr)
                return fn(*args, **kwargs)
            out = fn(*args, **kwargs)
            try:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")
                tmp.write_text(json.dumps(out, default=str))
                # Atomic: a run interrupted mid-write must not leave a partial
                # entry that later reads as a complete answer.
                tmp.replace(path)
            except Exception as exc:
                print(f"cache write failed for {name}: {exc}", file=sys.stderr)
            return out
        wrapper.uncached = fn
        return wrapper
    return deco


def clear():
    n = 0
    for f in CACHE_DIR.glob("*.json"):
        f.unlink()
        n += 1
    return n


if __name__ == "__main__":
    if "--clear" in sys.argv:
        print(f"cleared {clear()} cache entries")
    else:
        files = sorted(CACHE_DIR.glob("*.json"))
        total = sum(f.stat().st_size for f in files)
        print(f"{len(files)} entries, {total / 1e6:.1f} MB in {CACHE_DIR}")
        for f in files:
            print(f"  {f.stat().st_size / 1e3:>8.0f} KB  {f.name}")
