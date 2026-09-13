#!/usr/bin/env python3
"""
Check the two lists that are maintained by hand against what the code does.

Both fail silently, which is why they are checked rather than remembered:

  * The entity count in the README is prose, so adding an entity to tvweb.js
    leaves it wrong with nothing to notice. It had drifted to 61 in one file
    and 69 in four others against a real 70.
  * deploy.sh copies a hardcoded FILES list. An asset added to server/assets
    and left out of it is simply never installed, and the TV falls back to
    whatever the previous deploy left there - so the feature works on the
    developer's set and on nobody else's.

    ./scripts/check-drift.py

Exits non-zero if either has fallen out of step.
"""
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
problems = []


def entity_count():
    """Discovery configs published on a fully-capable set with allowPower on."""
    src = (root / 'server' / 'tvweb.js').read_text(encoding='utf-8')
    start = src.index('var entities = [')
    open_at = start + src[start:].index('[')
    depth = 0
    for i in range(open_at, len(src)):
        if src[i] == '[':
            depth += 1
        elif src[i] == ']':
            depth -= 1
            if depth == 0:
                end = i
                break
    else:
        sys.exit('check-drift: could not find the end of the entities array')

    decl = r"type:\s*'(\w+)',\s*\n?\s*id:\s*'(\w+)'"
    in_array = re.findall(decl, src[open_at:end])
    # The power entities are pushed after the literal, under CONFIG.allowPower.
    pushed = re.findall(r"entities\.push\(\{\s*\n?\s*" + decl, src[end:])
    return len(in_array) + len(pushed)


def check_counts(count):
    """
    "up to 70 entities", "Up to 70 native entities". Matched against the whole
    document rather than line by line: the count and the word it qualifies are
    split across a line break in the README, and a check that quietly skips a
    reference is the thing this script exists to prevent.
    """
    pattern = re.compile(r'up to (\d+)\s+(?:native\s+)?entities', re.I)
    checked = 0
    for doc in sorted(list(root.glob('*.md')) + list((root / 'docs').glob('*.md'))):
        text = doc.read_text(encoding='utf-8')
        for m in pattern.finditer(text):
            checked += 1
            if int(m.group(1)) != count:
                problems.append('%s:%d: says %s entities, tvweb.js publishes %d'
                                % (doc.relative_to(root), text[:m.start()].count('\n') + 1,
                                   m.group(1), count))
    if not checked:
        problems.append('no documented entity count found - has the wording changed?')
    return checked


def check_deploy():
    deploy = (root / 'server' / 'deploy.sh').read_text(encoding='utf-8')
    m = re.search(r'^FILES="(.*?)"', deploy, re.S | re.M)
    if not m:
        problems.append('server/deploy.sh: no FILES list found')
        return set()
    listed = set(m.group(1).replace('\\\n', ' ').split())
    on_disk = set()
    for f in (root / 'server' / 'assets').rglob('*'):
        if f.is_file():
            on_disk.add(str(f.relative_to(root / 'server')))
    for missing in sorted(on_disk - listed):
        problems.append('server/deploy.sh: %s is not in FILES, so it is never installed' % missing)
    for gone in sorted(f for f in listed - on_disk if f.startswith('assets/')):
        problems.append('server/deploy.sh: FILES lists %s, which does not exist' % gone)
    return on_disk


count = entity_count()
documented = check_counts(count)
assets = check_deploy()

for p in problems:
    print(p)
print('%d entities published, %d documented count%s checked, %d assets in FILES, %d problem%s'
      % (count, documented, '' if documented == 1 else 's',
         len(assets), len(problems), '' if len(problems) == 1 else 's'))
sys.exit(1 if problems else 0)
