#!/usr/bin/env bash
#
# Canonicalize the member order of a pbxproj `targets = ( ... );` array.
#
# Why (issue #4080): XcodeGen 2.46.0 emits the PBXProject `targets` array in one
# of two stable-but-environment-dependent orders for the same spec + version --
# declaration order (CtrlProxyApp, ObjCExceptionCatcher, CtrlProxy, ...) on some
# runners and alphabetical order (CtrlProxy, CtrlProxyApp, ...) on others. The
# committed file flip-flopped between the two across #3969/#3983/#3981, and the
# drift check reported each pure reorder as staleness even though not one byte of
# real content changed. Pinning the XcodeGen *version* did not fix it because
# both orders come out of the same pinned version. This normalizer folds that one
# array's ordering out so the drift check can stay strict about everything else.
#
# `normalize_pbxproj_targets` reads a pbxproj on stdin and writes an identical
# copy to stdout with the members of every `targets = ( ... );` block sorted
# (LC_ALL=C, byte order). Every other line is preserved verbatim, so a genuine
# content change still shows up. Members carry stable UUID + comment strings, so
# sorting yields the same output regardless of which order XcodeGen chose.
#
# In a pbxproj the `targets` key belongs to PBXProject only (scheme targets live
# in .xcscheme files, not here), so normalizing every `targets = (` block is
# safe -- other arrays (files, children, dependencies) are left untouched.
#
# This file is meant to be sourced (it only defines a function; no side effects).
# It can also be run directly as a stdin->stdout filter for manual inspection.

normalize_pbxproj_targets() {
    local line
    local -a block=()
    local in_block=0

    while IFS= read -r line || [ -n "${line}" ]; do
        if [ "${in_block}" -eq 0 ]; then
            printf '%s\n' "${line}"
            if [[ "${line}" =~ ^[[:space:]]*targets[[:space:]]*=[[:space:]]*\($ ]]; then
                in_block=1
                block=()
            fi
            continue
        fi

        if [[ "${line}" =~ ^[[:space:]]*\)\; ]]; then
            if [ ${#block[@]} -gt 0 ]; then
                printf '%s\n' "${block[@]}" | LC_ALL=C sort
            fi
            printf '%s\n' "${line}"
            in_block=0
        else
            block+=("${line}")
        fi
    done
}

# When executed (not sourced), act as a stdin->stdout filter.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    normalize_pbxproj_targets
fi
