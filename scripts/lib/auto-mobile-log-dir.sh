#!/usr/bin/env bash
# Resolve the same AutoMobile log directory that the TypeScript runtime uses.

normalize_automobile_log_dir_path() {
  local root="/"
  local path
  local protected_component_count=0
  if [[ "${2:-}" == "preserve-unc" && "$1" == //* ]]; then
    root="//"
    path="${1#//}"
    protected_component_count=2
  else
    path="${1#/}"
  fi
  local component
  local last_index
  local -a components=()

  while [[ -n "$path" ]]; do
    component="${path%%/*}"
    if [[ "$path" == */* ]]; then
      path="${path#*/}"
    else
      path=""
    fi

    case "$component" in
      ""|.)
        ;;
      ..)
        if (( ${#components[@]} > protected_component_count )); then
          last_index=$((${#components[@]} - 1))
          unset "components[$last_index]"
        fi
        ;;
      *)
        components+=("$component")
        ;;
    esac
  done

  if (( ${#components[@]} == 0 )); then
    printf '%s\n' "$root"
    return
  fi

  local IFS="/"
  printf '%s%s\n' "$root" "${components[*]}"
}

automobile_windows_path_to_bash_path() {
  local windows_path="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$windows_path"
    return
  fi
  printf '%s\n' "$windows_path"
}

automobile_is_windows_path() {
  [[ "$1" =~ ^[[:alpha:]]: || "$1" == \\\\* || "$1" == //* ]]
}

automobile_unix_home_dir() {
  local user_id
  user_id="$(id -u 2>/dev/null || true)"
  [[ -n "$user_id" ]] || return

  if command -v getent >/dev/null 2>&1; then
    getent passwd "$user_id" | awk -F: 'NR == 1 { print $6 }'
    return
  fi

  if command -v dscl >/dev/null 2>&1; then
    local user_name
    user_name="$(id -un 2>/dev/null || true)"
    [[ -n "$user_name" ]] || return
    dscl . -read "/Users/$user_name" NFSHomeDirectory 2>/dev/null |
      awk 'NR == 1 { sub(/^NFSHomeDirectory:[[:space:]]*/, ""); print }'
  fi
}

automobile_data_dir_override() {
  local data_dir
  if [[ -n "${AUTOMOBILE_DATA_DIR+x}" ]]; then
    data_dir="$AUTOMOBILE_DATA_DIR"
  else
    data_dir="${AUTO_MOBILE_DATA_DIR-}"
  fi
  data_dir="${data_dir#"${data_dir%%[![:space:]]*}"}"
  data_dir="${data_dir%"${data_dir##*[![:space:]]}"}"
  printf '%s\n' "$data_dir"
}

automobile_daemon_launch_dir() {
  local launch_dir="${AUTOMOBILE_DAEMON_LAUNCH_CWD:-$PWD}"
  launch_dir="${launch_dir#"${launch_dir%%[![:space:]]*}"}"
  launch_dir="${launch_dir%"${launch_dir##*[![:space:]]}"}"
  if [[ "${OS:-}" == "Windows_NT" ]] && automobile_is_windows_path "$launch_dir"; then
    launch_dir="$(automobile_windows_path_to_bash_path "$launch_dir")"
  fi
  [[ "$launch_dir" = /* ]] || launch_dir="$PWD"
  printf '%s\n' "$launch_dir"
}

automobile_windows_temp_dir() {
  local temp_dir="${TEMP:-${TMP:-${TMPDIR:-/tmp}}}"
  if automobile_is_windows_path "$temp_dir"; then
    automobile_windows_path_to_bash_path "$temp_dir"
    return
  fi

  temp_dir="${temp_dir//\\//}"
  if [[ "$temp_dir" != /* ]]; then
    temp_dir="$(automobile_daemon_launch_dir)/$temp_dir"
  fi
  if [[ "$temp_dir" == //* ]]; then
    normalize_automobile_log_dir_path "$temp_dir" "preserve-unc"
  else
    normalize_automobile_log_dir_path "$temp_dir"
  fi
}

automobile_windows_user_name() {
  printf '%s\n' "${USERNAME:-${USER:-$(id -un 2>/dev/null || printf 'default')}}"
}

automobile_windows_rooted_path_from_launch_dir() {
  local rooted_path="$1"
  local launch_dir="$2"
  if [[ "$launch_dir" =~ ^/[[:alpha:]](/|$) ]]; then
    normalize_automobile_log_dir_path "${launch_dir:0:2}/${rooted_path#/}"
    return
  fi

  if [[ "$launch_dir" == //* ]]; then
    local unc_path="${launch_dir#//}"
    local unc_server="${unc_path%%/*}"
    local unc_remainder="${unc_path#*/}"
    local unc_share="${unc_remainder%%/*}"
    if [[ "$unc_server" != "$unc_path" && -n "$unc_share" ]]; then
      normalize_automobile_log_dir_path "//$unc_server/$unc_share/${rooted_path#/}" "preserve-unc"
      return
    fi
  fi

  normalize_automobile_log_dir_path "$rooted_path"
}

automobile_directory_is_owned_by_current_user() {
  [[ "$(id -u 2>/dev/null || true)" == "0" || -O "$1" ]]
}

automobile_directory_is_creatable() {
  local requested_directory="$1"
  local directory="$requested_directory"
  if [[ -e "$requested_directory" ]]; then
    [[ -d "$requested_directory" && ! -L "$requested_directory" ]] || return 1
    if [[ "${OS:-}" != "Windows_NT" ]]; then
      automobile_directory_is_owned_by_current_user "$requested_directory"
    else
      [[ -w "$requested_directory" && -x "$requested_directory" ]]
    fi
    return
  fi

  while [[ ! -e "$directory" && ! -L "$directory" && "$directory" != "/" ]]; do
    if [[ "$directory" == */* ]]; then
      directory="${directory%/*}"
      directory="${directory:-/}"
    else
      directory="/"
    fi
  done
  [[ -d "$directory" && -w "$directory" && -x "$directory" ]]
}

resolve_automobile_log_dir() {
  local log_dir
  if [[ -n "${AUTOMOBILE_LOG_DIR+x}" ]]; then
    log_dir="$AUTOMOBILE_LOG_DIR"
  else
    log_dir="${AUTO_MOBILE_LOG_DIR-}"
  fi
  log_dir="${log_dir#"${log_dir%%[![:space:]]*}"}"
  log_dir="${log_dir%"${log_dir##*[![:space:]]}"}"

  if [[ -n "$log_dir" ]]; then
    if [[ "${OS:-}" == "Windows_NT" ]]; then
      if automobile_is_windows_path "$log_dir"; then
        automobile_windows_path_to_bash_path "$log_dir"
        return
      fi
      log_dir="${log_dir//\\//}"
      if [[ "$log_dir" = /* ]]; then
        automobile_windows_rooted_path_from_launch_dir "$log_dir" "$(automobile_daemon_launch_dir)"
        return
      fi
    fi

    if [[ "$log_dir" = /* ]]; then
      normalize_automobile_log_dir_path "$log_dir"
      return
    fi

    local launch_dir
    launch_dir="$(automobile_daemon_launch_dir)"
    if [[ "${OS:-}" == "Windows_NT" && "$launch_dir" == //* ]]; then
      normalize_automobile_log_dir_path "${launch_dir%/}/$log_dir" "preserve-unc"
    else
      normalize_automobile_log_dir_path "${launch_dir%/}/$log_dir"
    fi
    return
  fi

  local home_dir="${HOME:-}"
  if [[ "${OS:-}" == "Windows_NT" ]]; then
    home_dir="${USERPROFILE:-$home_dir}"
    if [[ -z "$home_dir" && -n "${HOMEDRIVE:-}" && -n "${HOMEPATH:-}" ]]; then
      home_dir="${HOMEDRIVE}${HOMEPATH}"
    fi
    if automobile_is_windows_path "$home_dir"; then
      home_dir="$(automobile_windows_path_to_bash_path "$home_dir")"
    fi
  elif [[ -z "$home_dir" ]]; then
    home_dir="$(automobile_unix_home_dir)"
  fi

  if [[ -n "$home_dir" ]]; then
    local launch_dir
    launch_dir="$(automobile_daemon_launch_dir)"
    if [[ "$home_dir" == //* && "${OS:-}" == "Windows_NT" ]]; then
      home_dir="$(normalize_automobile_log_dir_path "$home_dir" "preserve-unc")"
    elif [[ "$home_dir" = /* ]]; then
      home_dir="$(normalize_automobile_log_dir_path "$home_dir")"
    elif [[ "${OS:-}" == "Windows_NT" && "$launch_dir" == //* ]]; then
      home_dir="$(normalize_automobile_log_dir_path "${launch_dir%/}/$home_dir" "preserve-unc")"
    else
      home_dir="$(normalize_automobile_log_dir_path "${launch_dir%/}/$home_dir")"
    fi
    local home_logs_dir="${home_dir%/}/.auto-mobile/logs"
    local data_dir
    data_dir="$(automobile_data_dir_override)"
    if [[ -n "$data_dir" ]] && { [[ -L "$home_logs_dir" ]] || ! automobile_directory_is_creatable "$home_logs_dir"; }; then
      local data_dir_was_windows_path=false
      if [[ "${OS:-}" == "Windows_NT" ]]; then
        if automobile_is_windows_path "$data_dir"; then
          data_dir="$(automobile_windows_path_to_bash_path "$data_dir")"
          data_dir_was_windows_path=true
        else
          data_dir="${data_dir//\\//}"
        fi
      fi
      if [[ "$data_dir" = /* ]]; then
        if [[ "${OS:-}" == "Windows_NT" && "$data_dir_was_windows_path" == false ]]; then
          data_dir="$(automobile_windows_rooted_path_from_launch_dir "$data_dir" "$launch_dir")"
        fi
        if [[ "${OS:-}" == "Windows_NT" && "$data_dir" == //* ]]; then
          normalize_automobile_log_dir_path "${data_dir%/}/logs" "preserve-unc"
        else
          normalize_automobile_log_dir_path "${data_dir%/}/logs"
        fi
      else
        if [[ "${OS:-}" == "Windows_NT" && "$launch_dir" == //* ]]; then
          normalize_automobile_log_dir_path "${launch_dir%/}/$data_dir/logs" "preserve-unc"
        else
          normalize_automobile_log_dir_path "${launch_dir%/}/$data_dir/logs"
        fi
      fi
      return
    fi
    printf '%s\n' "$home_logs_dir"
    return
  fi

  if [[ "${OS:-}" == "Windows_NT" ]]; then
    local windows_temp_dir
    windows_temp_dir="$(automobile_windows_temp_dir)"
    local windows_user_name
    windows_user_name="$(automobile_windows_user_name)"
    if [[ "$windows_temp_dir" == //* ]]; then
      normalize_automobile_log_dir_path "${windows_temp_dir%/}/auto-mobile-${windows_user_name}" "preserve-unc"
    else
      normalize_automobile_log_dir_path "${windows_temp_dir%/}/auto-mobile-${windows_user_name}"
    fi
    return
  fi

  local user_id
  user_id="$(id -u 2>/dev/null || printf 'default')"
  printf '/tmp/auto-mobile-%s\n' "$user_id"
}
