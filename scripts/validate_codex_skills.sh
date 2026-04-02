#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILLS_DIR="${PROJECT_ROOT}/skills"
AGENTS_FILE="${PROJECT_ROOT}/AGENTS.md"

if [[ ! -d "${SKILLS_DIR}" ]]; then
  echo "[ERROR] skills/ directory not found" >&2
  exit 1
fi

if [[ ! -f "${AGENTS_FILE}" ]]; then
  echo "[ERROR] AGENTS.md not found" >&2
  exit 1
fi

errors=0

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

skill_files=()
while IFS= read -r file; do
  skill_files+=("$file")
done < <(find "${SKILLS_DIR}" -mindepth 2 -maxdepth 2 -type f -name 'SKILL.md' | sort)

if [[ "${#skill_files[@]}" -eq 0 ]]; then
  echo "[ERROR] No skill files found under skills/" >&2
  exit 1
fi

echo "Validating ${#skill_files[@]} Codex skill file(s)..."

skill_paths=()
skill_names=()

for file in "${skill_files[@]}"; do
  rel_path="${file#"${PROJECT_ROOT}/"}"
  dir_name="$(basename "$(dirname "$file")")"

  first_line="$(sed -n '1p' "$file")"
  if [[ "$first_line" != "---" ]]; then
    echo "[ERROR] ${rel_path}: missing opening YAML frontmatter delimiter" >&2
    errors=1
    continue
  fi

  second_delim_line="$(awk 'NR > 1 && $0 == "---" { print NR; exit }' "$file")"
  if [[ -z "$second_delim_line" ]]; then
    echo "[ERROR] ${rel_path}: missing closing YAML frontmatter delimiter" >&2
    errors=1
    continue
  fi

  frontmatter="$(sed -n "2,$((second_delim_line - 1))p" "$file")"
  name_line="$(printf '%s\n' "$frontmatter" | sed -n 's/^name:[[:space:]]*//p' | head -n 1)"
  description_line="$(printf '%s\n' "$frontmatter" | sed -n 's/^description:[[:space:]]*//p' | head -n 1)"
  skill_name="$(trim "$name_line")"
  description="$(trim "$description_line")"

  if [[ -z "$skill_name" ]]; then
    echo "[ERROR] ${rel_path}: missing frontmatter name" >&2
    errors=1
  fi

  if [[ -z "$description" ]]; then
    echo "[ERROR] ${rel_path}: missing frontmatter description" >&2
    errors=1
  fi

  if [[ -n "$skill_name" && "$skill_name" != "$dir_name" ]]; then
    echo "[ERROR] ${rel_path}: frontmatter name '${skill_name}' does not match directory '${dir_name}'" >&2
    errors=1
  fi

  if [[ -n "$skill_name" ]] && printf '%s\n' "${skill_names[@]-}" | grep -Fxq "$skill_name"; then
    echo "[ERROR] ${rel_path}: duplicate skill name '${skill_name}'" >&2
    errors=1
  fi

  skill_paths+=("$rel_path")
  if [[ -n "$skill_name" ]]; then
    skill_names+=("$skill_name")
  fi
done

agents_entries=()
agents_names=()

while IFS=$'\t' read -r listed_name listed_path; do
  listed_name="$(trim "$listed_name")"
  listed_path="$(trim "$listed_path")"

  if [[ -z "$listed_name" || -z "$listed_path" ]]; then
    echo "[ERROR] AGENTS.md: malformed skill entry '${listed_name} ${listed_path}'" >&2
    errors=1
    continue
  fi

  if [[ ! -f "${PROJECT_ROOT}/${listed_path}" ]]; then
    echo "[ERROR] AGENTS.md: listed skill path does not exist: ${listed_path}" >&2
    errors=1
  fi

  if [[ "${listed_path}" != skills/*/SKILL.md ]]; then
    echo "[ERROR] AGENTS.md: skill path must point to skills/*/SKILL.md: ${listed_path}" >&2
    errors=1
  fi

  expected_name="$(basename "$(dirname "${listed_path}")")"
  if [[ "${listed_name}" != "${expected_name}" ]]; then
    echo "[ERROR] AGENTS.md: listed name '${listed_name}' does not match path '${listed_path}'" >&2
    errors=1
  fi

  if printf '%s\n' "${agents_names[@]-}" | grep -Fxq "$listed_name"; then
    echo "[ERROR] AGENTS.md: duplicate skill entry '${listed_name}'" >&2
    errors=1
  fi

  agents_entries+=("$listed_path")
  agents_names+=("$listed_name")
done < <(
  awk '
    /^## Skills$/ { in_skills = 1; next }
    in_skills && /^## / { exit }
    in_skills && /^- / {
      line = $0
      name = line
      sub(/^- /, "", name)
      sub(/:.*$/, "", name)
      path = line
      sub(/^.*Path: `/, "", path)
      sub(/`.*$/, "", path)
      print name "\t" path
    }
  ' "${AGENTS_FILE}"
)

for path in "${skill_paths[@]}"; do
  if ! printf '%s\n' "${agents_entries[@]-}" | grep -Fxq "$path"; then
    echo "[ERROR] AGENTS.md: missing skill entry for ${path}" >&2
    errors=1
  fi
done

for path in "${agents_entries[@]}"; do
  if ! printf '%s\n' "${skill_paths[@]-}" | grep -Fxq "$path"; then
    echo "[ERROR] AGENTS.md: references non-local or missing skill ${path}" >&2
    errors=1
  fi
done

if [[ "$errors" -ne 0 ]]; then
  exit 1
fi

echo "✓ Codex skills validated successfully"
