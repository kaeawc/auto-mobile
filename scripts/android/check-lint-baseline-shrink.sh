#!/usr/bin/env bash
# Compare normalized finding identities as multisets; pre-push includes local edits.
# Git and jj-only workspaces compare committed revisions by default.
set -euo pipefail

base_ref=origin/main
revision=HEAD
allow_grow=false
worktree=false
usage() {
  cat <<'HELP'
Usage: scripts/android/check-lint-baseline-shrink.sh [--base-ref <ref>] [--worktree] [--allow-grow]

Compare Android lint baselines at HEAD (jj: @-) with its merge-base with the
base ref (default origin/main). Finding identities (id, message, location files)
may only be removed; line/column/errorLine changes are ignored. New baseline
files may only use identities removed from existing baselines, including duplicates.
--worktree includes staged, unstaged and
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

# shellcheck source=scripts/lib/vcs-diff.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/vcs-diff.sh"
cd "$(vcs_root)"
base_ref="$(vcs_base_ref "$base_ref")"
base_status="$(set +e; vcs_base_exists "$base_ref" > /dev/null 2>&1; echo $?)"
if [[ "$base_status" != 0 ]]; then
  echo "error: base ref does not exist: $base_ref" >&2
  exit 2
fi
vcs=git
jj_status="$(set +e; vcs_uses_jj > /dev/null 2>&1; echo $?)"
if [[ "$jj_status" == 0 ]]; then
  vcs=jj
  revision=@-
  merge_base="$(jj log -r "fork_point(${revision} | ${base_ref})" --no-graph -T commit_id)"
else
  merge_base="$(git merge-base "$base_ref" "$revision")"
fi
# ElementTree is already used by validate-sdk-debug-inspector-consumer.sh: it
# handles multiline attributes, comments and entities without an XML dependency.
python3 - "$merge_base" "$revision" "$worktree" "$allow_grow" "$vcs" <<'PY'
import collections
import pathlib
import subprocess
import sys
import xml.etree.ElementTree as ET

base, revision, worktree, allow_grow, vcs = sys.argv[1:]


def command(*args):
    return subprocess.check_output(args)


def revision_paths(rev):
    if vcs == 'jj':
        return set(command('jj', 'file', 'list', '-r', rev).decode().splitlines())
    return {p.decode() for p in command('git', 'ls-tree', '-r', '--name-only', '-z', rev).split(b'\0') if p}


def revision_file(rev, path):
    if vcs == 'jj':
        return command('jj', 'file', 'show', '-r', rev, path)
    return command('git', 'show', f'{rev}:{path}')


def baseline_paths(paths):
    return {p for p in paths if p.startswith('android/') and p.endswith('/lint-baseline.xml')}


def identities(data):
    root = ET.fromstring(data)
    if root.tag != 'issues':
        raise ValueError('expected <issues> root')
    result = collections.Counter()
    for issue in root.findall('issue'):
        # Decode XML entities and ignore attribute order and shifting source
        # coordinates. Include all location files, even for multi-location issues.
        identity = (issue.attrib['id'], issue.get('message', ''),
                    tuple(sorted(location.attrib['file'] for location in issue.findall('location'))))
        result[identity] += 1
    return result


def counts(entries):
    result = collections.Counter()
    for (issue, _, _), count in entries.items():
        result[issue] += count
    return result


try:
    base_paths = revision_paths(base)
    # Bootstrap only when the guard is genuinely absent, never on a VCS error.
    if 'scripts/android/check-lint-baseline-shrink.sh' not in base_paths:
        print('Android lint baseline guard introduced by this change; initial baselines accepted.')
        sys.exit(0)
    old_paths = baseline_paths(base_paths)
    if worktree == 'true':
        if vcs == 'jj':
            paths = baseline_paths(revision_paths('@'))
        else:
            paths = baseline_paths(p.decode() for p in command(
                'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0') if p)
        paths = {p for p in paths if pathlib.Path(p).is_file()}
    else:
        paths = baseline_paths(revision_paths(revision))
    previous_entries = {path: identities(revision_file(base, path)) for path in sorted(old_paths)}
    current_entries = {
        path: identities(pathlib.Path(path).read_bytes() if worktree == 'true'
                         else revision_file(revision, path))
        for path in sorted(paths)
    }
    previous_counts = {path: counts(entries) for path, entries in previous_entries.items()}
    current_counts = {path: counts(entries) for path, entries in current_entries.items()}
    # Counter subtraction keeps only positive differences, so growth in one
    # existing file cannot cancel another file's shrink for the same identity.
    shrink_pool = collections.Counter()
    for path, previous in previous_entries.items():
        shrink_pool.update(previous - current_entries.get(path, collections.Counter()))

    failures = []
    for path in sorted(paths & old_paths):
        current = current_counts[path]
        previous = previous_counts[path]
        if sum(current.values()) > sum(previous.values()):
            failures.append(f'{path}: total {sum(previous.values())} -> {sum(current.values())}')
        for issue, count in sorted(current.items()):
            if count > previous[issue]:
                failures.append(f'{path}: {issue} {previous[issue]} -> {count}')
        for (issue, message, locations), count in sorted((current_entries[path] - previous_entries[path]).items()):
            failures.append(f'{path}: {issue} new identity ({count}): {message!r} at {locations}')
    for path in sorted(paths - old_paths):
        current = current_entries[path]
        overages = current - shrink_pool
        # Keep rejecting empty new files: they do not move any findings.
        if not current or overages:
            failures.append(f'{path}: new baseline ({sum(current.values())} issues)')
        pool_counts = counts(shrink_pool)
        for issue, count in sorted(counts(overages).items()):
            failures.append(f'{path}: {issue} {pool_counts[issue]} -> {counts(current)[issue]}')
        for (issue, message, locations), count in sorted(overages.items()):
            failures.append(f'{path}: {issue} new identity ({count}): {message!r} at {locations}')
        shrink_pool = shrink_pool - current

    previous_total = sum(sum(c.values()) for c in previous_counts.values())
    current_total = sum(sum(c.values()) for c in current_counts.values())
    if current_total > previous_total:
        failures.append(f'all baselines: total {previous_total} -> {current_total}')
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
