"""
tracer.py — enhanced with heap/object tracking for Python Tutor style viz.
Each step returns:
  { line, scope, line_text, locals: [...], heap: {...} }
"""

import sys, io, traceback, builtins, types

# ── Sandbox ───────────────────────────────────────────────────────────────────
ALLOWED_BUILTINS = {
    "abs","all","any","bin","bool","chr","dict","dir","divmod",
    "enumerate","filter","float","format","frozenset","getattr",
    "hasattr","hash","hex","id","int","isinstance","issubclass",
    "iter","len","list","map","max","min","next","oct","ord",
    "pow","print","range","repr","reversed","round","set",
    "setattr","slice","sorted","str","sum","tuple","type","zip",
    "None","True","False","NotImplemented","Ellipsis",
    "Exception","ValueError","TypeError","KeyError","IndexError",
    "AttributeError","RuntimeError","StopIteration","ZeroDivisionError",
    "NameError","OverflowError","RecursionError","FileNotFoundError","IOError"
}
_safe_builtins = {k: getattr(builtins, k) for k in ALLOWED_BUILTINS if hasattr(builtins, k)}
MAX_STEPS = 500

# ── Built-in Stack ──────────────────────────────────────────────────────────── 
class Stack:
    def __init__(self):
        self._items = []
    
    def push(self, item):
        self._items.append(item)
        
    def pop(self):
        if not self._items:
            raise IndexError("pop from empty stack")
        return self._items.pop()
        
    def isEmpty(self):
        return len(self._items) == 0
        
    def peek(self):
        if not self._items:
            raise IndexError("peek from empty stack")
        return self._items[-1]
        
    def __repr__(self):
        return f"<Stack size={len(self._items)}>"

# ── Virtual File System ───────────────────────────────────────────────────────
class VirtualFileSystem:
    def __init__(self):
        # filename -> { content: str, mode: str, cursor: int, closed: bool }
        self.files = {}

    def open(self, filename, mode="r", **kwargs):
        valid_modes = ("r", "w", "a", "r+", "w+", "a+", "rb", "wb", "ab", "rb+", "wb+", "ab+")
        if mode not in valid_modes:
            raise ValueError(f"invalid mode: '{mode}'")
        
        # kwargs are ignored but allowed for compatibility (e.g., newline='')
            
        if filename not in self.files:
            if "r" in mode and "+" not in mode:
                raise FileNotFoundError(f"[Errno 2] No such file or directory: '{filename}'")
            self.files[filename] = {"content": "", "mode": mode, "cursor": 0, "closed": False}
        
        fobj = self.files[filename]
        fobj["closed"] = False
        fobj["mode"] = mode
        
        is_binary = "b" in mode
        
        if "w" in mode:
            fobj["content"] = b"" if is_binary else ""
            fobj["cursor"] = 0
        elif "a" in mode:
            fobj["cursor"] = len(fobj["content"])
        else:
            if is_binary and isinstance(fobj["content"], str):
                fobj["content"] = fobj["content"].encode("utf-8")
            elif not is_binary and isinstance(fobj["content"], bytes):
                fobj["content"] = fobj["content"].decode("utf-8", errors="replace")
            fobj["cursor"] = 0

        return MockFile(self, filename)

    def snapshot(self):
        def _snap_content(c):
            if isinstance(c, bytes):
                return f"<Binary: {c.hex(' ')}>" # Show as hex
            return str(c)
            
        return {
            name: {
                "content": _snap_content(f["content"]),
                "mode": f["mode"],
                "cursor": f["cursor"],
                "closed": f["closed"]
            }
            for name, f in self.files.items()
        }

class MockFile:
    def __init__(self, vfs, filename):
        self.vfs = vfs
        self.filename = filename

    @property
    def _data(self):
        if self.filename not in self.vfs.files:
            raise IOError("File is missing from VFS")
        return self.vfs.files[self.filename]

    def _check_open(self):
        if self._data["closed"]:
            raise ValueError("I/O operation on closed file.")

    def read(self, size=-1):
        self._check_open()
        d = self._data
        if "r" not in d["mode"] and "+" not in d["mode"]:
            raise IOError("File not open for reading")
        
        c = d["content"]
        cur = d["cursor"]
        if size < 0:
            res = c[cur:]
            d["cursor"] = len(c)
        else:
            res = c[cur:cur + size]
            d["cursor"] = min(len(c), cur + size)
        return res

    def write(self, text):
        self._check_open()
        d = self._data
        if "w" not in d["mode"] and "a" not in d["mode"] and "+" not in d["mode"]:
            raise IOError("File not open for writing")
        
        c = d["content"]
        cur = d["cursor"]
        
        is_binary = isinstance(c, bytes)
        # Ensure text is bytes if file is binary
        if is_binary and not isinstance(text, bytes):
            text = str(text).encode("utf-8")
        elif not is_binary and not isinstance(text, str):
            text = str(text)
            
        # Replace content at cursor
        new_content = c[:cur] + text + c[cur + len(text):]
        d["content"] = new_content
        d["cursor"] = cur + len(text)
        return len(text)

    def close(self):
        if self.filename in self.vfs.files:
            self.vfs.files[self.filename]["closed"] = True

    def seek(self, offset, whence=0):
        self._check_open()
        d = self._data
        if whence == 0:
            d["cursor"] = max(0, min(len(d["content"]), offset))
        elif whence == 1:
            d["cursor"] = max(0, min(len(d["content"]), d["cursor"] + offset))
        elif whence == 2:
            d["cursor"] = max(0, min(len(d["content"]), len(d["content"]) + offset))
        return d["cursor"]

    def readline(self, size=-1):
        self._check_open()
        d = self._data
        content = d["content"]
        cur = d["cursor"]
        
        is_binary = isinstance(content, bytes)
        newline = b"\n" if is_binary else "\n"
        
        idx = content.find(newline, cur)
        if idx == -1:
            res = content[cur:]
            d["cursor"] = len(content)
        else:
            res = content[cur:idx+1]
            d["cursor"] = idx + 1
            
        if size >= 0:
            # truncate to size
            extra = len(res) - size
            if extra > 0:
                res = res[:size]
                d["cursor"] -= extra
        return res

    def __iter__(self):
        return self
    
    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def tell(self):
        self._check_open()
        return self._data["cursor"]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

# ── Repr helpers ───────────────────────────────────────────────────────────────
def _short_repr(value, depth=0):
    if depth > 2: return "…"
    try:
        if isinstance(value, (int, float, bool, type(None))): return repr(value)
        if isinstance(value, str):
            s = repr(value)
            return s[:60] + "…'" if len(s) > 60 else s
        if isinstance(value, (list, tuple)):
            b = "[]" if isinstance(value, list) else "()"
            items = [_short_repr(v, depth+1) for v in value[:8]]
            suf = ", …" if len(value) > 8 else ""
            return f"{b[0]}{', '.join(items)}{suf}{b[1]}"
        if isinstance(value, dict):
            items = [f"{_short_repr(k,depth+1)}: {_short_repr(v,depth+1)}" for k,v in list(value.items())[:5]]
            suf = ", …" if len(value) > 5 else ""
            return "{" + ", ".join(items) + suf + "}"
        if isinstance(value, set):
            items = [_short_repr(v, depth+1) for v in list(value)[:5]]
            suf = ", …" if len(value) > 5 else ""
            return "{" + ", ".join(items) + suf + "}"
        return repr(value)[:120]
    except Exception: return "<unprintable>"

# ── Heap object descriptor ─────────────────────────────────────────────────────
def _heap_descriptor(value):
    """Returns a dict describing a compound object for the heap panel."""
    if isinstance(value, list):
        return {"type": "list", "items": [_short_repr(v) for v in value[:20]],
                "length": len(value)}
    if isinstance(value, tuple):
        return {"type": "tuple", "items": [_short_repr(v) for v in value[:20]],
                "length": len(value)}
    if isinstance(value, dict):
        return {"type": "dict",
                "entries": [[_short_repr(k), _short_repr(v)] for k,v in list(value.items())[:10]],
                "length": len(value)}
    if isinstance(value, set):
        return {"type": "set", "items": sorted([_short_repr(v) for v in list(value)[:10]]),
                "length": len(value)}
    # Custom objects / class instances
    if isinstance(value, Stack):
        return {"type": "Stack", "items": [_short_repr(v) for v in value._items]}
    if isinstance(value, MockFile):
        return {"type": "File", "repr": f"<file '{value.filename}'>"}

    return {"type": type(value).__name__, "repr": _short_repr(value)}

# Primitive types that should be shown inline (not in heap)
_PRIMITIVES = (int, float, bool, type(None), str)

def _is_primitive(value):
    return isinstance(value, _PRIMITIVES)

# ── Frame snapshot ─────────────────────────────────────────────────────────────
def _snapshot_frame(local_vars: dict, global_vars: dict):
    """
    Returns (locals_list, heap_dict).
    locals_list: [{name, is_primitive, value, type, ref_id?}]
    heap_dict:   {"id<n>": descriptor}
    """
    locals_list = []
    heap = {}
    skip = ("__", ".")

    for name, val in local_vars.items():
        if any(name.startswith(p) for p in skip): continue
        if callable(val) and not isinstance(val, type): continue
        if isinstance(val, types.ModuleType): continue

        typ = type(val).__name__
        if _is_primitive(val):
            locals_list.append({
                "name": name,
                "is_primitive": True,
                "value": _short_repr(val),
                "type": typ,
            })
        else:
            ref_id = f"id{id(val)}"
            locals_list.append({
                "name": name,
                "is_primitive": False,
                "value": _short_repr(val),
                "type": typ,
                "ref_id": ref_id,
            })
            heap[ref_id] = _heap_descriptor(val)

    # Scan globals for heap objects so they stay alive when inside a function
    for name, val in global_vars.items():
        if any(name.startswith(p) for p in skip): continue
        if callable(val) and not isinstance(val, type): continue
        if isinstance(val, types.ModuleType): continue
        if not _is_primitive(val):
            ref_id = f"id{id(val)}"
            heap[ref_id] = _heap_descriptor(val)

    return locals_list, heap

# ── Tracer ─────────────────────────────────────────────────────────────────────
class _Tracer:
    def __init__(self, source_lines, vfs, stdout_capture):
        self.steps = []
        self.source_lines = source_lines
        self.vfs = vfs
        self.stdout_capture = stdout_capture
        self._done = False

    def trace_calls(self, frame, event, arg):
        if self._done: return None
        if event == "call" and frame.f_code.co_filename == "<visualizer>":
            return self.trace_lines
        return None

    def trace_lines(self, frame, event, arg):
        if self._done: return None
        if event == "line":
            lineno = frame.f_lineno
            line_text = ""
            if 1 <= lineno <= len(self.source_lines):
                line_text = self.source_lines[lineno - 1].rstrip()

            locals_list, heap = _snapshot_frame(frame.f_locals, frame.f_globals)
            self.steps.append({
                "line": lineno,
                "scope": frame.f_code.co_name,
                "line_text": line_text,
                "locals": locals_list,
                "heap": heap,
                "vfs": self.vfs.snapshot(),
                "stdout": self.stdout_capture.getvalue(),
            })
            if len(self.steps) >= MAX_STEPS:
                self._done = True
                return None
        return self.trace_lines

# ── Public API ─────────────────────────────────────────────────────────────────
def run_trace(source: str) -> dict:
    source = source.strip()
    if not source:
        return {"steps": [], "stdout": "", "error": None}

    source_lines = source.splitlines()
    try:
        code = compile(source, "<visualizer>", "exec")
    except SyntaxError as exc:
        return {"steps": [], "stdout": "",
                "error": f"SyntaxError on line {exc.lineno}: {exc.msg}"}

    vfs = VirtualFileSystem()
    stdout_capture = io.StringIO()
    tracer = _Tracer(source_lines, vfs, stdout_capture)
    safe_print = _make_safe_print(stdout_capture)
    safe_globals = {
        "__builtins__": {
            **_safe_builtins, 
            "print": safe_print, 
            "open": vfs.open,
            "__import__": __import__
        },
        "__name__": "__main__",
        "Stack": Stack,
        "pickle": __import__("pickle"),
        "csv": __import__("csv"),
    }

    error_msg = None
    old_trace = sys.gettrace()
    try:
        sys.settrace(tracer.trace_calls)
        exec(code, safe_globals)  # noqa: S102
    except Exception:
        error_msg = traceback.format_exc()
    finally:
        sys.settrace(old_trace)
        tracer._done = True
        
        # Append one final `<EOF>` step to capture the state AFTER the last line executes
        # This is crucial for grabbing the `stdout` and VFS of the final line if it had a side-effect.
        try:
            # We don't have frame locals/globals here easily without inspecting frames
            # but usually the final state doesn't add locals. Just copy the last step's locals/heap
            # and update the stdout/vfs.
            last_locals = tracer.steps[-1]["locals"] if tracer.steps else []
            last_heap = tracer.steps[-1]["heap"] if tracer.steps else {}
            
            tracer.steps.append({
                "line": tracer.steps[-1]["line"] if tracer.steps else 1, # keep arrow on last line
                "scope": tracer.steps[-1]["scope"] if tracer.steps else "<module>",
                "line_text": "<EOF>",
                "locals": last_locals,
                "heap": last_heap,
                "vfs": vfs.snapshot(),
                "stdout": stdout_capture.getvalue(),
            })
        except Exception:
            pass

    return {
        "steps": tracer.steps,
        "stdout": stdout_capture.getvalue(),
        "error": error_msg,
        "truncated": len(tracer.steps) >= MAX_STEPS,
    }

def _make_safe_print(buffer):
    def _print(*args, sep=" ", end="\n", **_kw):
        buffer.write(sep.join(str(a) for a in args) + end)
    return _print
