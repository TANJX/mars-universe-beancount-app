"""Patches and edit operations over plain YAML/JSON data.

A runway scenario is a *patch* over its person's base mapping. Mappings merge
key by key; a list whose items all carry an `id` (or, failing that, a `from`
month) merges item by item on that key, and `{id: x, remove: true}` drops an
item. Any other value (scalars, other lists) replaces.

`diff_patch(new, old)` builds the smallest patch with
`apply_patch(old, patch) == new`. `diff_ops(new, old)` turns the same
comparison into edit operations (set / delete / append at a path) that can be
replayed on a comment-preserving YAML document, so a save touches only what
changed. The web app has a TypeScript twin (apps/web/lib/runway/patch.ts) for
live previews; keep the two in step.
"""

from __future__ import annotations

import copy
from typing import Any

KEYS = ("id", "from")
REMOVE = "remove"


def list_key(*lists: Any) -> str | None:
    """The merge key shared by every item of every list, or None.

    Empty lists do not vote. A list with no items at all on every side has no
    key (it replaces)."""
    items = [x for lst in lists if isinstance(lst, list) for x in lst]
    if not items or not all(isinstance(x, dict) for x in items):
        return None
    for key in KEYS:
        if all(key in x and x[key] is not None for x in items):
            seen: list[set] = []
            for lst in lists:
                vals = [str(x[key]) for x in lst or []]
                if len(vals) != len(set(vals)):
                    return None
                seen.append(set(vals))
            return key
    return None


def _kv(x: dict, key: str) -> str:
    return str(x[key])


def apply_patch(base: Any, patch: Any) -> Any:
    """`base` with `patch` applied. Neither argument is modified."""
    if isinstance(base, dict) and isinstance(patch, dict):
        out = copy.deepcopy(base)
        for k, v in patch.items():
            if k in out:
                out[k] = apply_patch(out[k], v)
            elif isinstance(v, list) and list_key(v):
                # A keyed list patched onto nothing: drop removal markers.
                out[k] = [_strip_remove(x) for x in v if not x.get(REMOVE)]
            else:
                out[k] = copy.deepcopy(v)
        return out
    if isinstance(base, list) and isinstance(patch, list) and patch:
        key = list_key(base, patch) if base else list_key(patch)
        if key is not None:
            out = copy.deepcopy(base)
            for item in patch:
                idx = next((i for i, x in enumerate(out) if _kv(x, key) == _kv(item, key)), None)
                if item.get(REMOVE) is True:
                    if idx is not None:
                        out.pop(idx)
                elif idx is not None:
                    out[idx] = apply_patch(out[idx], _strip_remove(item))
                else:
                    out.append(_strip_remove(item))
            return out
    return copy.deepcopy(patch)


def _strip_remove(x: Any) -> Any:
    if isinstance(x, dict) and REMOVE in x:
        return {k: copy.deepcopy(v) for k, v in x.items() if k != REMOVE}
    return copy.deepcopy(x)


def diff_patch(new: Any, old: Any) -> Any:
    """Smallest patch turning `old` into `new`. For two mappings the result
    is a mapping ({} when equal); a key `old` has and `new` lacks becomes
    `None`."""
    if isinstance(new, dict) and isinstance(old, dict):
        out: dict = {}
        for k, v in new.items():
            if k not in old:
                out[k] = copy.deepcopy(v)
            elif v != old[k]:
                key = list_key(v, old[k]) if isinstance(v, list) and isinstance(old[k], list) else None
                if isinstance(v, dict) and isinstance(old[k], dict):
                    sub: Any = diff_patch(v, old[k])
                elif key is not None:
                    sub = _diff_list(v, old[k], key)
                else:
                    out[k] = copy.deepcopy(v)
                    continue
                # Empty only when the difference was item order in a keyed list.
                if sub:
                    out[k] = sub
        for k in old:
            if k not in new:
                out[k] = None
        return out
    return copy.deepcopy(new)


def _diff_list(new: list, old: list, key: str) -> list:
    old_by = {_kv(x, key): x for x in old}
    new_keys = {_kv(x, key) for x in new}
    out: list = []
    for item in new:
        k = _kv(item, key)
        prev = old_by.get(k)
        if prev is None:
            out.append(copy.deepcopy(item))
        elif item != prev:
            sub = diff_patch(item, prev)
            out.append({key: item[key], **{a: b for a, b in sub.items() if a != key}})
    for x in old:
        if _kv(x, key) not in new_keys:
            out.append({key: x[key], REMOVE: True})
    return out


# ---------- edit operations ----------

Op = dict  # {"op": "set" | "delete" | "append", "path": [...], "value"?: Any}


def sel(key: str, value: Any) -> dict:
    """A path segment picking the list item whose `key` equals `value`."""
    return {"key": key, "value": value}


def diff_ops(new: Any, old: Any, path: list | None = None) -> list[Op]:
    """Operations that turn `old` into `new`, finest-grained first: mappings
    recurse key by key and keyed lists item by item, so untouched siblings
    (and their YAML comments) stay as they are."""
    path = list(path or [])
    if new == old:
        return []
    if isinstance(new, dict) and isinstance(old, dict):
        ops: list[Op] = []
        for k, v in new.items():
            if k not in old:
                ops.append({"op": "set", "path": [*path, k], "value": copy.deepcopy(v)})
            else:
                ops.extend(diff_ops(v, old[k], [*path, k]))
        for k in old:
            if k not in new:
                ops.append({"op": "delete", "path": [*path, k]})
        return ops
    if isinstance(new, list) and isinstance(old, list):
        key = list_key(new, old)
        if key is not None:
            ops = []
            old_by = {_kv(x, key): x for x in old}
            new_keys = {_kv(x, key) for x in new}
            for x in old:
                if _kv(x, key) not in new_keys:
                    ops.append({"op": "delete", "path": [*path, sel(key, x[key])]})
            for item in new:
                prev = old_by.get(_kv(item, key))
                if prev is None:
                    ops.append({"op": "append", "path": path, "value": copy.deepcopy(item)})
                else:
                    ops.extend(diff_ops(item, prev, [*path, sel(key, item[key])]))
            return ops
    return [{"op": "set", "path": path, "value": copy.deepcopy(new)}]
