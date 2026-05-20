"""Beancount formatter compatible with dongfg/vscode-beancount-formatter.

The VS Code extension and beancount's bundled `bean-format` CLI disagree on
auto-detected number width when postings contain math expressions like
``(13.95 / 4 * 2)``: the extension's regex treats the whole expression as one
"number" and pads the file to accommodate it; beancount's CLI does not.

This module reproduces the extension's algorithm so the hook and `just format`
produce byte-identical output to what VS Code's Format Document command writes.
"""

import argparse
import re
import sys
from pathlib import Path


CURRENCY_RE = re.compile(
    r"^([^\";]*?)"
    r"\s+"
    r"((?=[\d+(-])(?:[\d\s+*/)(\-]|,\d|\.\d)*(?<=\d)\)*)"
    r"\s+"
    r"([A-Z][A-Z0-9'._\-]{0,22}[A-Z0-9])\b"
    r"(.*)$"
)
ACCOUNT_RE = re.compile(r"^(\s+)([A-Z][\w:.\-]+)")


def _most_frequent(values: list[int]) -> int:
    if not values:
        return 0
    counts: dict[int, int] = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _normalize_indent(pairs):
    widths = []
    for prefix, *_ in pairs:
        if prefix is None:
            continue
        m = ACCOUNT_RE.match(prefix)
        if m:
            widths.append(len(m.group(1)))
    width = _most_frequent(widths)
    indent = " " * width

    out = []
    for entry in pairs:
        prefix, number, currency, rest, raw = entry
        if prefix is not None:
            m = ACCOUNT_RE.match(prefix)
            if m:
                prefix = indent + prefix[m.start(2):]
        out.append((prefix, number, currency, rest, raw))
    return out


def format_contents(text: str, prefix_width=None, num_width=None) -> str:
    lines = text.split("\n")
    pairs = []
    for line in lines:
        m = CURRENCY_RE.match(line)
        if m:
            pairs.append((*m.groups(), line))
        else:
            pairs.append((None, None, None, None, line))

    pairs = _normalize_indent(pairs)

    posted = [(p, n) for p, n, _, _, _ in pairs if p is not None]
    max_prefix = max((len(p) for p, _ in posted), default=0)
    max_num = max((len(n) for _, n in posted), default=0)

    if prefix_width:
        max_prefix = prefix_width
    if num_width:
        max_num = num_width

    out_lines = []
    for prefix, number, currency, rest, raw in pairs:
        if prefix is None:
            out_lines.append(raw)
        else:
            padded_prefix = prefix.rstrip().ljust(max_prefix)
            padded_num = number.rjust(max_num)
            out_lines.append(f"{padded_prefix}  {padded_num} {currency}{rest}")
    return "\n".join(out_lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-w", "--prefix-width", type=int)
    parser.add_argument("-W", "--num-width", type=int)
    parser.add_argument("-i", "--in-place", action="store_true")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args(argv)

    for path in args.files:
        p = Path(path)
        original = p.read_text()
        formatted = format_contents(
            original,
            prefix_width=args.prefix_width,
            num_width=args.num_width,
        )
        if args.in_place:
            if formatted != original:
                p.write_text(formatted)
        else:
            sys.stdout.write(formatted)


if __name__ == "__main__":
    main()
