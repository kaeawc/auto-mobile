#!/bin/bash

# The website is built using MkDocs with the Material theme.
# https://squidfunk.github.io/mkdocs-material/
# It requires Python to run.
# Install the packages with the following command:
# pip install mkdocs mkdocs-material mdx_truly_sane_lists

if [[ "$1" = "--local" ]]; then local=true; fi

if [[ ${local} ]]; then
  # Local preview: build and serve straight from the current working tree.
  # Copy in special files that GitHub wants in the project root.
  cp CHANGELOG.md docs/changelog.md
  cp .github/CONTRIBUTING.md docs/contributing.md
  mkdocs serve
else
  set -ex

  export GIT_CLONE_PROTECTION_ACTIVE=false
  REPO="git@github.com:kaeawc/auto-mobile.git"
  DIR=temp-clone

  # Deploy from a fresh clone so we never publish uncommitted local state.
  # (Previously the clone was created then immediately deleted with nothing
  # done inside it, so gh-deploy ran against the dirty working tree — #3656.)
  rm -rf "${DIR}"
  git clone "${REPO}" "${DIR}"
  (
    cd "${DIR}"
    # Copy in special files that GitHub wants in the project root.
    cp CHANGELOG.md docs/changelog.md
    cp .github/CONTRIBUTING.md docs/contributing.md
    # Build the site and push the new files up to GitHub.
    mkdocs gh-deploy
  )

  # Delete our temp folder.
  rm -rf "${DIR}"
fi
