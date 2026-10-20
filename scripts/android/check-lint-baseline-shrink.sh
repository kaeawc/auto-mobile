#!/usr/bin/env bash
# Compare committed baselines by default; pre-push also checks local edits.
set -euo pipefail

base_ref=origin/main
revision=HEAD
allow_grow=false
worktree=false
usage() {
  cat <<'HELP'
Usage: scripts/android/check-lint-baseline-shrink.sh [--base-ref <ref>] [--worktree] [--allow-grow]

Compare Android lint baseline counts at HEAD with the merge-base of HEAD and
origin/main. Counts must not grow, in total or for any issue id within a module;
new baseline files are forbidden. --worktree includes staged, unstaged and
untracked baselines instead of HEAD. --allow-grow is an explicit bootstrap escape
hatch, never used by the normal pre-push or CI gates.
HELP
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-ref)
      [[ $# -ge 2 ]] || { echo 'error: --base-ref requires a ref' >&2; exit 2; }
      base_ref="$2"
      shift 2
      ;;
    --worktree) worktree=true; shift ;;
    --allow-grow) allow_grow=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
merge_base="$(git merge-base "$base_ref" "$revision")"
# Bootstrap: the change that introduces this guard (and the initial baselines) has
# nothing to shrink from. Once the guard exists at the merge-base, it is strict.
if ! git cat-file -e "${merge_base}:scripts/android/check-lint-baseline-shrink.sh" 2>/dev/null; then
  echo "Android lint baseline guard introduced by this change; initial baselines accepted."
  exit 0
fi
# ElementTree is already used by validate-sdk-debug-inspector-consumer.sh: it
# handles multiline attributes, comments and entities without an XML dependency.
python3 - "$merge_base" "$revision" "$worktree" "$allow_grow" <<'PY'
import collections
import pathlib
import subprocess
import sys
import xml.etree.ElementTree as ET

base, revision, worktree, allow_grow = sys.argv[1:]


def git(*args):
    return subprocess.check_output(['git', *args])


def baseline_paths(raw):
    return {p.decode() for p in raw.split(b'\0')
            if p.startswith(b'android/') and p.endswith(b'/lint-baseline.xml')}


def counts(data):
    root = ET.fromstring(data)
    if root.tag != 'issues':
        raise ValueError('expected <issues> root')
    result = collections.Counter()
    for issue in root.findall('issue'):
        result[issue.attrib['id']] += 1
    return result


try:
    old_paths = baseline_paths(git('ls-tree', '-r', '--name-only', '-z', base))
    if worktree == 'true':
        paths = baseline_paths(git('ls-files', '--cached', '--others', '--exclude-standard', '-z'))
        paths = {p for p in paths if pathlib.Path(p).is_file()}
    else:
        paths = baseline_paths(git('ls-tree', '-r', '--name-only', '-z', revision))
    failures = []
    for path in sorted(paths):
        current = counts(pathlib.Path(path).read_bytes() if worktree == 'true'
                         else git('show', f'{revision}:{path}'))
        if path not in old_paths:
            failures.append(f'{path}: new baseline ({sum(current.values())} issues)')
            continue
        previous = counts(git('show', f'{base}:{path}'))
        if sum(current.values()) > sum(previous.values()):
            failures.append(f'{path}: total {sum(previous.values())} -> {sum(current.values())}')
        for issue, count in sorted(current.items()):
            if count > previous[issue]:
                failures.append(f'{path}: {issue} {previous[issue]} -> {count}')
    for failure in failures:
        print(f'Lint baseline growth: {failure}')
    if failures and allow_grow != 'true':
        print('Android lint baselines may only shrink. Fix the findings instead of adding to the baseline.', file=sys.stderr)
        sys.exit(1)
    if failures:
        print('Android lint baseline growth explicitly allowed (--allow-grow).')
    else:
        print(f'Android lint baselines are shrink-only ({len(paths)} files checked).')
except (subprocess.CalledProcessError, OSError, ValueError, KeyError, ET.ParseError) as error:
    print(f'error: cannot check Android lint baselines: {error}', file=sys.stderr)
    sys.exit(2)
PY
