#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILLS_DIR="${PROJECT_ROOT}/skills"
AGENTS_SKILLS_DIR="${PROJECT_ROOT}/.agents/skills"
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

is_quoted() {
  local value="$1"
  [[ "$value" == \"*\" || "$value" == \'*\' ]]
}

# Strip one layer of matching surrounding quotes so a quoted and an unquoted
# frontmatter description compare equal by VALUE. Representation may differ
# (a description containing ': ' must be quoted); the value must not.
# Validate a Codex interface metadata file (agents/openai.yaml).
# Args: <openai_yaml_path> <skill_name>. Sets `errors=1` on any failure.
validate_openai_yaml() {
  local openai_yaml="$1"
  local skill_name="$2"
  local openai_rel_path="${openai_yaml#"${PROJECT_ROOT}/"}"
  local display_name short_description default_prompt

  display_name="$(sed -n 's/^[[:space:]]*display_name:[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$openai_yaml" | head -n 1)"
  short_description="$(sed -n 's/^[[:space:]]*short_description:[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$openai_yaml" | head -n 1)"
  default_prompt="$(sed -n 's/^[[:space:]]*default_prompt:[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$openai_yaml" | head -n 1)"

  if ! grep -Eq '^interface:[[:space:]]*$' "$openai_yaml"; then
    echo "[ERROR] ${openai_rel_path}: missing top-level interface block" >&2
    errors=1
  fi

  if [[ -z "$display_name" ]]; then
    echo "[ERROR] ${openai_rel_path}: missing quoted interface.display_name" >&2
    errors=1
  fi

  if [[ -z "$short_description" ]]; then
    echo "[ERROR] ${openai_rel_path}: missing quoted interface.short_description" >&2
    errors=1
  fi

  if [[ -z "$default_prompt" ]]; then
    echo "[ERROR] ${openai_rel_path}: missing quoted interface.default_prompt" >&2
    errors=1
  elif [[ -n "$skill_name" && "$default_prompt" != *"\$${skill_name}"* ]]; then
    echo "[ERROR] ${openai_rel_path}: default_prompt must mention \$${skill_name}" >&2
    errors=1
  fi
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
skills_with_openai_metadata=()

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

  if [[ "$description_line" == *": "* ]] && ! is_quoted "$description_line"; then
    echo "[ERROR] ${rel_path}: frontmatter description containing ': ' must be quoted" >&2
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

  openai_yaml="$(dirname "$file")/agents/openai.yaml"
  if [[ -f "$openai_yaml" ]]; then
    validate_openai_yaml "$openai_yaml" "$skill_name"

    if [[ -n "$skill_name" ]]; then
      skills_with_openai_metadata+=("$skill_name")
    fi
  fi
done

if [[ -d "${AGENTS_SKILLS_DIR}" ]]; then
  agents_skill_files=()
  while IFS= read -r entry; do
    rel_path="${entry#"${PROJECT_ROOT}/"}"
    wrapper_file="${entry}/SKILL.md"

    if [[ -L "$entry" ]]; then
      echo "[ERROR] ${rel_path}: .agents skill wrapper directories must not be symlinks" >&2
      errors=1
      continue
    fi

    if [[ ! -d "$entry" ]]; then
      echo "[ERROR] ${rel_path}: .agents skill wrapper must be a directory" >&2
      errors=1
      continue
    fi

    if [[ -L "$wrapper_file" ]]; then
      echo "[ERROR] ${wrapper_file#"${PROJECT_ROOT}/"}: .agents skill wrapper files must not be symlinks" >&2
      errors=1
      continue
    fi

    if [[ ! -f "$wrapper_file" ]]; then
      echo "[ERROR] ${wrapper_file#"${PROJECT_ROOT}/"}: missing .agents skill wrapper file" >&2
      errors=1
      continue
    fi

    agents_skill_files+=("$wrapper_file")
  done < <(find "${AGENTS_SKILLS_DIR}" -mindepth 1 -maxdepth 1 | sort)

  # bash 3.2 errors on "${arr[@]}" for an empty array under `set -u`.
  for file in ${agents_skill_files[@]+"${agents_skill_files[@]}"}; do
    rel_path="${file#"${PROJECT_ROOT}/"}"
    dir_name="$(basename "$(dirname "$file")")"

    canonical_path="skills/${dir_name}/SKILL.md"
    if [[ ! -f "${PROJECT_ROOT}/${canonical_path}" ]]; then
      echo "[ERROR] ${rel_path}: no canonical skill found at ${canonical_path}" >&2
      errors=1
    fi

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
    wrapper_name="$(trim "$name_line")"
    wrapper_description="$(trim "$description_line")"

    if [[ "$wrapper_name" != "$dir_name" ]]; then
      echo "[ERROR] ${rel_path}: frontmatter name '${wrapper_name}' does not match directory '${dir_name}'" >&2
      errors=1
    fi

    if [[ -z "$wrapper_description" ]]; then
      echo "[ERROR] ${rel_path}: missing frontmatter description" >&2
      errors=1
    fi

    if [[ "$description_line" == *": "* ]] && ! is_quoted "$description_line"; then
      echo "[ERROR] ${rel_path}: frontmatter description containing ': ' must be quoted" >&2
      errors=1
    fi

    if ! grep -Fq "../../../${canonical_path}" "$file"; then
      echo "[ERROR] ${rel_path}: wrapper must reference ../../../${canonical_path}" >&2
      errors=1
    fi

    # The wrapper duplicates the canonical description rather than pointing at
    # it, so it drifts silently: Codex surfaces the wrapper's copy while the
    # canonical skill says something else. Compare by value, not by raw line.
    if [[ -f "${PROJECT_ROOT}/${canonical_path}" ]]; then
      canonical_desc_line="$(awk '
        NR == 1 && $0 != "---" { exit }
        NR > 1 && $0 == "---" { exit }
        NR > 1' "${PROJECT_ROOT}/${canonical_path}" \
        | sed -n 's/^description:[[:space:]]*//p' | head -n 1)"
      # Invoke unquote separately, never inside an `if` condition: that
      # disables set -e for the call (SC2310, see #3637/#3640).
      # Byte-identical, not semantically-equal. Decoding YAML scalars by hand kept
      # producing false drift (escaped quotes, bash 3.2 replacement semantics,
      # literal \n ordering), and the repo bans hand-rolled parsing of structured
      # formats. The wrapper is generated from the canonical, so requiring the
      # exact same line is both achievable and stricter.
      canonical_description="$(trim "$canonical_desc_line")"
      if [[ -n "$canonical_description" ]] \
        && [[ "$wrapper_description" != "$canonical_description" ]]; then
        echo "[ERROR] ${rel_path}: frontmatter description differs from ${canonical_path}" >&2
        echo "        copy the canonical description line verbatim, including its quoting" >&2
        echo "        canonical: ${canonical_description}" >&2
        echo "        wrapper:   ${wrapper_description}" >&2
        errors=1
      fi
    fi

    # Codex reads interface metadata next to the discoverable wrapper, not the
    # canonical source skill. If the canonical skill ships agents/openai.yaml,
    # the wrapper must colocate an equivalent one so the display name/default
    # prompt appears for the repo-discovered skill (issue #2901).
    canonical_openai_yaml="${PROJECT_ROOT}/skills/${dir_name}/agents/openai.yaml"
    wrapper_openai_yaml="$(dirname "$file")/agents/openai.yaml"
    if [[ -f "$canonical_openai_yaml" ]]; then
      if [[ -L "$wrapper_openai_yaml" ]]; then
        echo "[ERROR] ${wrapper_openai_yaml#"${PROJECT_ROOT}/"}: .agents skill metadata files must not be symlinks" >&2
        errors=1
      elif [[ ! -f "$wrapper_openai_yaml" ]]; then
        echo "[ERROR] ${wrapper_openai_yaml#"${PROJECT_ROOT}/"}: missing Codex interface metadata next to discoverable wrapper" >&2
        errors=1
      else
        validate_openai_yaml "$wrapper_openai_yaml" "$dir_name"
        # Same drift class as the description above: two copies, no pointer.
        if ! cmp -s "$canonical_openai_yaml" "$wrapper_openai_yaml"; then
          echo "[ERROR] ${wrapper_openai_yaml#"${PROJECT_ROOT}/"}: differs from ${canonical_openai_yaml#"${PROJECT_ROOT}/"}" >&2
          errors=1
        fi
      fi
    fi
  done
fi

for skill_name in ${skills_with_openai_metadata[@]+"${skills_with_openai_metadata[@]}"}; do
  wrapper_path="${AGENTS_SKILLS_DIR}/${skill_name}/SKILL.md"
  if [[ ! -f "$wrapper_path" ]]; then
    echo "[ERROR] .agents/skills: missing Codex discovery wrapper for ${skill_name}" >&2
    errors=1
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

for path in ${skill_paths[@]+"${skill_paths[@]}"}; do
  if ! grep -Fxq "$path" <<< "$(printf '%s\n' "${agents_entries[@]-}")"; then
    echo "[ERROR] AGENTS.md: missing skill entry for ${path}" >&2
    errors=1
  fi
done

for path in ${agents_entries[@]+"${agents_entries[@]}"}; do
  if ! grep -Fxq "$path" <<< "$(printf '%s\n' "${skill_paths[@]-}")"; then
    echo "[ERROR] AGENTS.md: references non-local or missing skill ${path}" >&2
    errors=1
  fi
done

if [[ "$errors" -ne 0 ]]; then
  exit 1
fi

echo "✓ Codex skills validated successfully"
