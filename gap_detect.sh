#!/usr/bin/env bash
#
# gap_detect.sh - Detect data flow gaps for GitHub-scheduled collectors
#
# USAGE:
#   ./gap_detect.sh                    # GitHub Actions checks only (requires gh CLI)
#   OPS_SECRET="..." ./gap_detect.sh   # Add heartbeat check
#   DATABASE_URL="..." ./gap_detect.sh # Add database check (auto-detect table/column)
#
#   # Dashboard alert_events monitoring (recommended for Polymarket Scanner)
#   DATABASE_URL="..." TRADES_TABLE="alert_events" TRADES_TS_COLUMN="fill_timestamp" ./gap_detect.sh
#
#   # Schema-qualified table (generic example)
#   DATABASE_URL="..." TRADES_TABLE="myschema.trades" TRADES_TS_COLUMN="created_at" ./gap_detect.sh
#
#   # Debug mode (shows SQL, detailed errors)
#   DEBUG=1 DATABASE_URL="..." ./gap_detect.sh
#
#   # Connection test only
#   CHECK_CONNECTION=1 DATABASE_URL="..." ./gap_detect.sh
#
# ENVIRONMENT VARIABLES:
#   DATABASE_URL                      Postgres connection string (required for DB checks)
#   TRADES_TABLE                      Table name, optionally schema-qualified (e.g., "trades" or "public.trades")
#   TRADES_TS_COLUMN                  Timestamp column name
#   OPS_SECRET                        Auth token for heartbeat endpoint
#   DEBUG                             Set to 1 for verbose output
#   CHECK_CONNECTION                  Set to 1 to test DB connection only
#   EXPECTED_INTERVAL_MINUTES         Expected data interval (default: 5)
#   MAX_ALLOWED_TRIGGER_GAP_MINUTES   Max acceptable gap between GitHub runs (default: 15)
#   MAX_ALLOWED_QUEUE_DELAY_MINUTES   Max acceptable queue delay (default: 10)
#   MAX_ALLOWED_INGEST_LAG_MINUTES    Max acceptable data lag (default: 20)
#   LOOKBACK_HOURS                    Hours of data to analyze (default: 6)
#   WORKFLOW_NAME                     GitHub workflow name (default: "Collect Trades")
#   RUN_LOOKBACK                      Number of GitHub runs to analyze (default: 20)
#   BASE_URL                          Base URL for heartbeat (default: https://poly-market-scanner.vercel.app)
#   MAX_NETWORK_CALLS                 Limit network calls (default: 10)
#
# EXIT CODES:
#   0 - All checks PASS (warnings allowed)
#   1 - At least one FAIL (gap/lag detected)
#   2 - Configuration/runtime error (missing env, cannot connect, etc.)
#
set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================
readonly EXPECTED_INTERVAL_MINUTES="${EXPECTED_INTERVAL_MINUTES:-5}"
readonly MAX_ALLOWED_TRIGGER_GAP_MINUTES="${MAX_ALLOWED_TRIGGER_GAP_MINUTES:-15}"
readonly MAX_ALLOWED_QUEUE_DELAY_MINUTES="${MAX_ALLOWED_QUEUE_DELAY_MINUTES:-10}"
readonly MAX_ALLOWED_INGEST_LAG_MINUTES="${MAX_ALLOWED_INGEST_LAG_MINUTES:-20}"
readonly LOOKBACK_HOURS="${LOOKBACK_HOURS:-6}"
readonly WORKFLOW_NAME="${WORKFLOW_NAME:-Collect Trades}"
readonly RUN_LOOKBACK="${RUN_LOOKBACK:-20}"
readonly BASE_URL="${BASE_URL:-https://poly-market-scanner.vercel.app}"
readonly HEARTBEAT_PATH="${HEARTBEAT_PATH:-/api/ops/health/heartbeat}"
readonly MAX_NETWORK_CALLS="${MAX_NETWORK_CALLS:-10}"
readonly DEBUG="${DEBUG:-0}"
readonly CHECK_CONNECTION="${CHECK_CONNECTION:-0}"

# Validate numeric configs (prevent SQL injection via config vars)
_validate_positive_int() {
    local val="$1" name="$2"
    if [[ ! "$val" =~ ^[0-9]+$ ]] || [[ "$val" -eq 0 ]]; then
        echo "[FAIL] $name must be a positive integer: got '$val'" >&2
        exit 2
    fi
}
_validate_positive_int "$EXPECTED_INTERVAL_MINUTES" "EXPECTED_INTERVAL_MINUTES"
_validate_positive_int "$MAX_ALLOWED_TRIGGER_GAP_MINUTES" "MAX_ALLOWED_TRIGGER_GAP_MINUTES"
_validate_positive_int "$MAX_ALLOWED_QUEUE_DELAY_MINUTES" "MAX_ALLOWED_QUEUE_DELAY_MINUTES"
_validate_positive_int "$MAX_ALLOWED_INGEST_LAG_MINUTES" "MAX_ALLOWED_INGEST_LAG_MINUTES"
_validate_positive_int "$LOOKBACK_HOURS" "LOOKBACK_HOURS"
_validate_positive_int "$RUN_LOOKBACK" "RUN_LOOKBACK"
_validate_positive_int "$MAX_NETWORK_CALLS" "MAX_NETWORK_CALLS"

# State tracking
HAVE_FAIL=0
HAVE_WARN=0
CHECKS_RUN=0
NETWORK_CALLS=0
NETWORK_LIMIT_REACHED=0

# Temp file management
declare -a TEMP_FILES=()

# =============================================================================
# Cleanup and temp file management
# =============================================================================
cleanup() {
    local f
    for f in "${TEMP_FILES[@]:-}"; do
        [[ -f "$f" ]] && rm -f "$f" 2>/dev/null || true
    done
}
trap cleanup EXIT

make_temp() {
    local tmp
    tmp=$(mktemp) || { echo "[FAIL] Cannot create temp file" >&2; exit 2; }
    TEMP_FILES+=("$tmp")
    printf '%s' "$tmp"
}

# =============================================================================
# Logging functions
# =============================================================================
log_debug() {
    [[ "$DEBUG" == "1" ]] && echo "[DEBUG] $1" >&2
    return 0
}

log_info() {
    echo "[INFO] $1"
}

log_warn() {
    echo "[WARN] $1"
    HAVE_WARN=1
    ((CHECKS_RUN++)) || true
}

log_fail() {
    echo "[FAIL] $1"
    HAVE_FAIL=1
    ((CHECKS_RUN++)) || true
}

log_pass() {
    echo "[PASS] $1"
    ((CHECKS_RUN++)) || true
}

log_skip() {
    echo "[SKIP] $1"
}

# =============================================================================
# Utility functions
# =============================================================================
log_header() {
    echo ""
    echo "========================================================================"
    echo "$1"
    echo "========================================================================"
}

# Safe integer parsing - returns 0 for invalid input
safe_int() {
    local val="${1:-0}"
    val="${val%%.*}"
    val="${val//[^0-9-]/}"
    if [[ "$val" =~ ^-?[0-9]+$ ]]; then
        printf '%s' "$val"
    else
        printf '0'
    fi
}

# Trim whitespace (macOS-compatible)
trim() {
    local var="$1"
    var="${var#"${var%%[![:space:]]*}"}"
    var="${var%"${var##*[![:space:]]}"}"
    printf '%s' "$var"
}

check_network_limit() {
    if [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]]; then
        return 1
    fi
    if [[ "$NETWORK_CALLS" -ge "$MAX_NETWORK_CALLS" ]]; then
        log_warn "Network call limit ($MAX_NETWORK_CALLS) reached - skipping further network checks"
        NETWORK_LIMIT_REACHED=1
        return 1
    fi
    ((NETWORK_CALLS++)) || true
    return 0
}

# =============================================================================
# Identifier validation and quoting
# =============================================================================
# Validates identifier: letters, digits, underscore only, must start with letter/underscore
# Returns 0 if valid, 1 if invalid
validate_identifier() {
    local val="$1"
    [[ "$val" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

# Parse table reference: "table" or "schema.table"
# Sets PARSED_SCHEMA and PARSED_TABLE globals
# Returns 0 on success, 1 on failure
parse_table_ref() {
    local ref="$1"
    PARSED_SCHEMA=""
    PARSED_TABLE=""

    # Check for unsafe characters (quotes, semicolons, etc.)
    if [[ "$ref" =~ [\"\'\;\$\`\\] ]]; then
        log_fail "Table reference contains unsafe characters: $ref"
        return 1
    fi

    if [[ "$ref" == *.* ]]; then
        # schema.table format
        PARSED_SCHEMA="${ref%%.*}"
        PARSED_TABLE="${ref#*.}"

        # Validate both parts
        if ! validate_identifier "$PARSED_SCHEMA"; then
            log_fail "Invalid schema name (must be alphanumeric/underscore): $PARSED_SCHEMA"
            return 1
        fi
        if ! validate_identifier "$PARSED_TABLE"; then
            log_fail "Invalid table name (must be alphanumeric/underscore): $PARSED_TABLE"
            return 1
        fi
    else
        # table only - default to public schema
        PARSED_SCHEMA="public"
        PARSED_TABLE="$ref"

        if ! validate_identifier "$PARSED_TABLE"; then
            log_fail "Invalid table name (must be alphanumeric/underscore): $PARSED_TABLE"
            return 1
        fi
    fi
    return 0
}

# Quote an identifier for SQL
quote_ident() {
    printf '"%s"' "$1"
}

# Get fully qualified quoted table reference
get_quoted_table() {
    printf '"%s"."%s"' "$PARSED_SCHEMA" "$PARSED_TABLE"
}

# =============================================================================
# PostgreSQL helper functions
# =============================================================================
readonly PSQL_OPTS=(-X -q -t -A -F '|' -P pager=off -v ON_ERROR_STOP=1)

# Print actionable hints based on error message
print_db_hints() {
    local stderr_content="$1"

    if [[ "$stderr_content" == *"SSL"* ]] || [[ "$stderr_content" == *"sslmode"* ]]; then
        log_info "Hint: Try adding ?sslmode=require to DATABASE_URL"
    fi
    if [[ "$stderr_content" == *"permission denied"* ]]; then
        log_info "Hint: Database user may lack SELECT permission. Run: GRANT SELECT ON table TO user;"
    fi
    if [[ "$stderr_content" == *"does not exist"* ]]; then
        log_info "Hint: Table or column may not exist - verify TRADES_TABLE and TRADES_TS_COLUMN"
    fi
    if [[ "$stderr_content" == *"no pg_hba.conf entry"* ]] || [[ "$stderr_content" == *"not allowed"* ]]; then
        log_info "Hint: IP may not be allowlisted - check database network/firewall settings"
    fi
    if [[ "$stderr_content" == *"could not connect"* ]] || [[ "$stderr_content" == *"timeout"* ]] || [[ "$stderr_content" == *"Connection refused"* ]]; then
        log_info "Hint: Cannot reach database host - check hostname, port, and network connectivity"
    fi
    if [[ "$stderr_content" == *"password authentication failed"* ]]; then
        log_info "Hint: Invalid credentials - verify username and password in DATABASE_URL"
    fi
}

# Execute SQL and return single row result (pipe-delimited, trimmed)
# Enforces single-row output by taking only the last non-empty line
# For multi-column results, parse with: cut -d'|' -f1, -f2, etc.
# Returns: exit code 0 on success, 2 on failure
run_psql_row() {
    local sql="$1"
    local desc="${2:-query}"
    local stderr_file result exit_code

    stderr_file=$(make_temp)

    log_debug "Running $desc"
    log_debug "SQL: $sql"

    set +e
    result=$(psql "${PSQL_OPTS[@]}" "$DATABASE_URL" -c "$sql" 2>"$stderr_file")
    exit_code=$?
    set -e

    if [[ $exit_code -ne 0 ]]; then
        local stderr_content
        stderr_content=$(cat "$stderr_file" 2>/dev/null || true)

        log_debug "Query failed with exit code $exit_code"

        if [[ -n "$stderr_content" ]]; then
            # Show last few lines of error (avoid flooding output)
            local snippet
            snippet=$(tail -5 "$stderr_file" 2>/dev/null || true)
            if [[ -n "$snippet" ]]; then
                log_info "DB error: $snippet"
            fi

            # Full stderr in debug mode
            if [[ "$DEBUG" == "1" && "$stderr_content" != "$snippet" ]]; then
                log_debug "Full stderr: $stderr_content"
            fi

            print_db_hints "$stderr_content"
        fi
        return 2
    fi

    # Enforce scalar: strip \r, take last non-empty line, trim whitespace
    result=$(printf '%s' "$result" | tr -d '\r' | grep -v '^$' | tail -n 1 || true)
    trim "$result"
}

# Execute SQL and return raw output (multi-line)
# Usage: result=$(run_psql_raw "SELECT * FROM t" "description")
run_psql_raw() {
    local sql="$1"
    local desc="${2:-query}"
    local stderr_file result exit_code

    stderr_file=$(make_temp)

    log_debug "Running $desc"
    log_debug "SQL: $sql"

    set +e
    result=$(psql "${PSQL_OPTS[@]}" "$DATABASE_URL" -c "$sql" 2>"$stderr_file")
    exit_code=$?
    set -e

    if [[ $exit_code -ne 0 ]]; then
        local stderr_content
        stderr_content=$(cat "$stderr_file" 2>/dev/null || true)

        if [[ -n "$stderr_content" ]]; then
            local snippet
            snippet=$(tail -5 "$stderr_file" 2>/dev/null || true)
            [[ -n "$snippet" ]] && log_info "DB error: $snippet"
            print_db_hints "$stderr_content"
        fi
        return 2
    fi

    printf '%s' "$result"
}

# =============================================================================
# Python helper for JSON parsing
# =============================================================================
check_python() {
    if command -v python3 &>/dev/null; then
        echo "python3"
    elif command -v python &>/dev/null; then
        echo "python"
    else
        echo ""
    fi
}

create_python_helper() {
    local helper_file
    helper_file=$(make_temp)
    cat > "$helper_file" <<'PYTHON_EOF'
import sys
import json
from datetime import datetime, timezone

def parse_iso(s):
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        if "+" in s or (len(s) > 10 and "-" in s[10:]):
            dt = datetime.fromisoformat(s)
        else:
            dt = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None

def minutes_diff(earlier, later):
    if not earlier or not later:
        return None
    diff = (later - earlier).total_seconds() / 60.0
    return diff

def now_utc():
    return datetime.now(timezone.utc)

def analyze_github_runs():
    try:
        runs = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return

    scheduled = [r for r in runs if r.get("event") == "schedule"]

    if not scheduled:
        print(json.dumps({"error": "NO_SCHEDULED_RUNS", "total_scheduled": 0}))
        return

    scheduled.sort(key=lambda x: x.get("createdAt", ""), reverse=True)

    results = {
        "total_scheduled": len(scheduled),
        "trigger_gaps": [],
        "queue_delays": [],
        "failed_runs": [],
        "max_trigger_gap": 0,
        "max_queue_delay": 0,
    }

    for i, run in enumerate(scheduled):
        created = parse_iso(run.get("createdAt"))
        started = parse_iso(run.get("startedAt"))
        conclusion = run.get("conclusion")
        run_id = run.get("databaseId", "unknown")
        html_url = run.get("htmlUrl", "")

        if created and started:
            delay = minutes_diff(created, started)
            if delay is not None and delay >= 0:
                results["queue_delays"].append({
                    "run_id": run_id,
                    "delay_min": round(delay, 1),
                    "created": run.get("createdAt"),
                    "htmlUrl": html_url,
                })
                results["max_queue_delay"] = max(results["max_queue_delay"], round(delay, 1))

        if i < len(scheduled) - 1:
            older_run = scheduled[i + 1]
            older_created = parse_iso(older_run.get("createdAt"))
            if created and older_created:
                gap = minutes_diff(older_created, created)
                if gap is not None and gap >= 0:
                    results["trigger_gaps"].append({
                        "newer_run": run_id,
                        "older_run": older_run.get("databaseId", "unknown"),
                        "gap_min": round(gap, 1),
                        "newer_time": run.get("createdAt"),
                        "older_time": older_run.get("createdAt"),
                        "htmlUrl": html_url,
                    })
                    results["max_trigger_gap"] = max(results["max_trigger_gap"], round(gap, 1))

        if conclusion and conclusion not in ("success", "skipped"):
            results["failed_runs"].append({
                "run_id": run_id,
                "conclusion": conclusion,
                "created": run.get("createdAt"),
                "htmlUrl": html_url,
            })

    print(json.dumps(results))

def analyze_heartbeat():
    try:
        data = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return

    ts_fields = [
        "last_trade_ingested_at",
        "last_ingest_at",
        "last_collect_trades_at",
        "timestamp",
        "generatedAt",
        "lastSuccessAt",
    ]

    found_ts = None
    found_field = None

    for field in ts_fields:
        if field in data and data[field]:
            found_ts = parse_iso(str(data[field]))
            found_field = field
            if found_ts:
                break

    if not found_ts and "checks" in data and isinstance(data["checks"], list):
        for check in data["checks"]:
            if isinstance(check, dict):
                for field in ts_fields:
                    if field in check and check[field]:
                        found_ts = parse_iso(str(check[field]))
                        found_field = "checks[]." + field
                        if found_ts:
                            break
            if found_ts:
                break

    result = {
        "ok": data.get("ok"),
        "found_timestamp": found_ts is not None,
        "timestamp_field": found_field,
        "lag_minutes": None,
    }

    if found_ts:
        lag = minutes_diff(found_ts, now_utc())
        result["lag_minutes"] = round(lag, 1) if lag is not None else None
        result["timestamp_value"] = found_ts.isoformat()

    print(json.dumps(result))

def get_json_field():
    field_name = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        data = json.load(sys.stdin)
        val = data.get(field_name)
        print(val if val is not None else "")
    except Exception:
        print("")

def filter_large_gaps():
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0
    try:
        data = json.load(sys.stdin)
        gaps = [g for g in data.get("trigger_gaps", []) if g["gap_min"] > threshold]
        for g in gaps[:10]:
            url_info = f" ({g['htmlUrl']})" if g.get("htmlUrl") else ""
            print(f"  Gap: {g['gap_min']} min between runs{url_info}")
        if len(gaps) > 10:
            print(f"  ... and {len(gaps) - 10} more")
        print(f"COUNT:{len(gaps)}")
    except Exception:
        print("COUNT:0")

def filter_delays():
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0
    try:
        data = json.load(sys.stdin)
        delays = [d for d in data.get("queue_delays", []) if d["delay_min"] > threshold]
        total = len(data.get("queue_delays", []))
        pct = (len(delays) / total * 100) if total > 0 else 0
        for d in delays[:5]:
            url_info = f" ({d['htmlUrl']})" if d.get("htmlUrl") else ""
            print(f"  Delay: {d['delay_min']} min for run {d['run_id']}{url_info}")
        if len(delays) > 5:
            print(f"  ... and {len(delays) - 5} more")
        print(f"COUNT:{len(delays)}")
        print(f"PCT:{pct:.1f}")
    except Exception:
        print("COUNT:0")
        print("PCT:0")

def filter_failed():
    try:
        data = json.load(sys.stdin)
        failed = data.get("failed_runs", [])
        for f in failed[:5]:
            url_info = f" ({f['htmlUrl']})" if f.get("htmlUrl") else ""
            print(f"  Run {f['run_id']}: {f['conclusion']} at {f['created']}{url_info}")
        if len(failed) > 5:
            print(f"  ... and {len(failed) - 5} more")
        print(f"COUNT:{len(failed)}")
    except Exception:
        print("COUNT:0")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""

    if cmd == "github":
        analyze_github_runs()
    elif cmd == "heartbeat":
        analyze_heartbeat()
    elif cmd == "field":
        get_json_field()
    elif cmd == "gaps":
        filter_large_gaps()
    elif cmd == "delays":
        filter_delays()
    elif cmd == "failed":
        filter_failed()
    else:
        print(json.dumps({"error": "Unknown command"}))
        sys.exit(1)
PYTHON_EOF
    echo "$helper_file"
}

# =============================================================================
# Main script
# =============================================================================

log_header "Gap Detection Script - $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

echo ""
echo "Configuration:"
echo "  EXPECTED_INTERVAL_MINUTES:        $EXPECTED_INTERVAL_MINUTES"
echo "  MAX_ALLOWED_TRIGGER_GAP_MINUTES:  $MAX_ALLOWED_TRIGGER_GAP_MINUTES"
echo "  MAX_ALLOWED_QUEUE_DELAY_MINUTES:  $MAX_ALLOWED_QUEUE_DELAY_MINUTES"
echo "  MAX_ALLOWED_INGEST_LAG_MINUTES:   $MAX_ALLOWED_INGEST_LAG_MINUTES"
echo "  WORKFLOW_NAME:                    $WORKFLOW_NAME"
echo "  RUN_LOOKBACK:                     $RUN_LOOKBACK"
echo "  BASE_URL:                         $BASE_URL"
echo "  LOOKBACK_HOURS:                   $LOOKBACK_HOURS"
echo "  OPS_SECRET:                       ${OPS_SECRET:+[SET]}"
echo "  DATABASE_URL:                     ${DATABASE_URL:+[SET]}"
echo "  DEBUG:                            $DEBUG"
echo "  CHECK_CONNECTION:                 $CHECK_CONNECTION"

PYTHON_CMD=$(check_python)
PYTHON_HELPER_FILE=""

if [[ -n "$PYTHON_CMD" ]]; then
    log_info "Using Python: $PYTHON_CMD"
    PYTHON_HELPER_FILE=$(create_python_helper)
else
    log_warn "Python not found - detailed JSON parsing will be limited"
fi

# =============================================================================
# CHECK_CONNECTION mode - early exit
# =============================================================================
if [[ "$CHECK_CONNECTION" == "1" ]]; then
    log_header "Connection Test Mode"

    if [[ -z "${DATABASE_URL:-}" ]]; then
        log_fail "DATABASE_URL is required for connection test"
        exit 2
    fi

    if ! command -v psql &>/dev/null; then
        log_fail "psql not installed"
        exit 2
    fi

    log_info "Testing database connectivity..."

    CONN_SQL="SELECT now() AS server_time, current_user AS db_user, current_database() AS db_name;"

    if CONN_RESULT=$(run_psql_row "$CONN_SQL" "connection test"); then
        log_pass "Database connection successful"
        log_info "Result: $CONN_RESULT"
        exit 0
    else
        log_fail "Database connection failed"
        exit 2
    fi
fi

# =============================================================================
# Section A: GitHub Actions Schedule Gap Detection
# =============================================================================

log_header "Section A: GitHub Actions Schedule Gap Detection"

if [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]]; then
    log_skip "Network limit already reached"
elif ! command -v gh &>/dev/null; then
    log_skip "gh CLI not installed - skipping GitHub checks"
    log_info "Install: https://cli.github.com/"
elif ! gh auth status &>/dev/null 2>&1; then
    log_skip "gh CLI not authenticated - skipping GitHub checks"
    log_info "Run: gh auth login"
elif ! check_network_limit; then
    log_skip "Network limit reached"
else
    log_info "Fetching last $RUN_LOOKBACK runs for workflow '$WORKFLOW_NAME'..."

    GH_RUNS_FILE=$(make_temp)

    if ! gh run list \
        --workflow "$WORKFLOW_NAME" \
        --limit "$RUN_LOOKBACK" \
        --json "createdAt,startedAt,conclusion,event,status,databaseId,headBranch,htmlUrl" \
        > "$GH_RUNS_FILE" 2>/dev/null; then
        log_warn "Failed to fetch workflow runs"
    elif [[ ! -s "$GH_RUNS_FILE" ]] || grep -q '^\[\]$' "$GH_RUNS_FILE" 2>/dev/null; then
        log_warn "No workflow runs found for '$WORKFLOW_NAME'"
    elif [[ -n "$PYTHON_CMD" && -n "$PYTHON_HELPER_FILE" ]]; then
        ANALYSIS_FILE=$(make_temp)

        if ! "$PYTHON_CMD" "$PYTHON_HELPER_FILE" github < "$GH_RUNS_FILE" > "$ANALYSIS_FILE" 2>/dev/null; then
            log_warn "Failed to analyze GitHub runs with Python"
        else
            ERROR_CHECK=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field error < "$ANALYSIS_FILE" 2>/dev/null || echo "")

            if [[ "$ERROR_CHECK" == "NO_SCHEDULED_RUNS" ]]; then
                log_warn "No scheduled runs found in last $RUN_LOOKBACK runs (only manual triggers?)"
            elif [[ -n "$ERROR_CHECK" ]]; then
                log_warn "Analysis error: $ERROR_CHECK"
            else
                TOTAL_SCHEDULED=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field total_scheduled < "$ANALYSIS_FILE" 2>/dev/null || echo "0")
                MAX_TRIGGER_GAP=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field max_trigger_gap < "$ANALYSIS_FILE" 2>/dev/null || echo "0")
                MAX_QUEUE_DELAY=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field max_queue_delay < "$ANALYSIS_FILE" 2>/dev/null || echo "0")

                TOTAL_SCHEDULED=$(safe_int "$TOTAL_SCHEDULED")

                log_info "Analyzed $TOTAL_SCHEDULED scheduled runs"
                log_info "Max trigger gap: ${MAX_TRIGGER_GAP:-0} minutes"
                log_info "Max queue delay: ${MAX_QUEUE_DELAY:-0} minutes"

                THRESHOLD_WITH_TOLERANCE=$((MAX_ALLOWED_TRIGGER_GAP_MINUTES + 1))

                LARGE_GAP_OUTPUT=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" gaps "$THRESHOLD_WITH_TOLERANCE" < "$ANALYSIS_FILE" 2>/dev/null || echo "COUNT:0")

                LARGE_GAP_COUNT=$(echo "$LARGE_GAP_OUTPUT" | grep "^COUNT:" | cut -d: -f2)
                LARGE_GAP_COUNT=$(safe_int "$LARGE_GAP_COUNT")
                LARGE_GAP_DETAILS=$(echo "$LARGE_GAP_OUTPUT" | grep -v "^COUNT:" || true)

                [[ -n "$LARGE_GAP_DETAILS" ]] && echo "$LARGE_GAP_DETAILS"

                if [[ "$LARGE_GAP_COUNT" -gt 0 ]]; then
                    log_fail "Found $LARGE_GAP_COUNT trigger gaps exceeding ${MAX_ALLOWED_TRIGGER_GAP_MINUTES} minutes"
                else
                    log_pass "No trigger gaps exceed ${MAX_ALLOWED_TRIGGER_GAP_MINUTES} minutes"
                fi

                DELAY_OUTPUT=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" delays "$MAX_ALLOWED_QUEUE_DELAY_MINUTES" < "$ANALYSIS_FILE" 2>/dev/null || printf "COUNT:0\nPCT:0\n")

                DELAY_COUNT=$(echo "$DELAY_OUTPUT" | grep "^COUNT:" | cut -d: -f2)
                DELAY_PCT=$(echo "$DELAY_OUTPUT" | grep "^PCT:" | cut -d: -f2)
                DELAY_DETAILS=$(echo "$DELAY_OUTPUT" | grep -v "^COUNT:" | grep -v "^PCT:" || true)

                DELAY_COUNT=$(safe_int "$DELAY_COUNT")
                DELAY_PCT_INT=$(safe_int "$DELAY_PCT")

                [[ -n "$DELAY_DETAILS" ]] && echo "$DELAY_DETAILS"

                if [[ "$DELAY_PCT_INT" -gt 20 ]]; then
                    log_fail "${DELAY_PCT}% of runs have queue delay > ${MAX_ALLOWED_QUEUE_DELAY_MINUTES} min (threshold: 20%)"
                elif [[ "$DELAY_COUNT" -gt 0 ]]; then
                    log_warn "${DELAY_COUNT} runs have queue delay > ${MAX_ALLOWED_QUEUE_DELAY_MINUTES} min (${DELAY_PCT}%)"
                else
                    log_pass "Queue delays within acceptable range"
                fi

                FAILED_OUTPUT=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" failed < "$ANALYSIS_FILE" 2>/dev/null || echo "COUNT:0")

                FAILED_COUNT=$(echo "$FAILED_OUTPUT" | grep "^COUNT:" | cut -d: -f2)
                FAILED_COUNT=$(safe_int "$FAILED_COUNT")
                FAILED_DETAILS=$(echo "$FAILED_OUTPUT" | grep -v "^COUNT:" || true)

                if [[ "$FAILED_COUNT" -gt 0 ]]; then
                    [[ -n "$FAILED_DETAILS" ]] && echo "$FAILED_DETAILS"
                    log_warn "${FAILED_COUNT} failed runs in lookback period"
                else
                    log_pass "No failed runs in lookback period"
                fi
            fi
        fi
    else
        log_warn "Python unavailable - performing basic GitHub check only"
        SCHEDULED_COUNT=$(grep -cE '"event"[[:space:]]*:[[:space:]]*"schedule"' "$GH_RUNS_FILE" 2>/dev/null || echo "0")
        SCHEDULED_COUNT=$(safe_int "$SCHEDULED_COUNT")

        if [[ "$SCHEDULED_COUNT" -eq 0 ]]; then
            log_warn "No scheduled runs found (detailed analysis requires Python)"
        else
            log_info "Found $SCHEDULED_COUNT scheduled runs (detailed gap analysis requires Python)"
            log_pass "Workflow runs exist - install Python for detailed analysis"
        fi
    fi
fi

# =============================================================================
# Section B: Heartbeat Freshness Check
# =============================================================================

log_header "Section B: Heartbeat Freshness Check"

if [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]]; then
    log_skip "Network limit already reached"
elif [[ -z "${OPS_SECRET:-}" ]]; then
    log_skip "OPS_SECRET not set - skipping heartbeat check"
elif ! check_network_limit; then
    log_skip "Network limit reached"
else
    HEARTBEAT_URL="${BASE_URL}${HEARTBEAT_PATH}"
    log_info "Checking heartbeat at: $HEARTBEAT_URL"

    HB_BODY_FILE=$(make_temp)
    CURL_CONFIG_FILE=$(make_temp)

    # Use curl config file to avoid exposing secret in process list
    printf 'header = "Authorization: Bearer %s"\n' "$OPS_SECRET" > "$CURL_CONFIG_FILE"
    chmod 600 "$CURL_CONFIG_FILE"

    HTTP_STATUS=$(curl -sS -w "%{http_code}" \
        --max-time 10 \
        -o "$HB_BODY_FILE" \
        -K "$CURL_CONFIG_FILE" \
        "$HEARTBEAT_URL" \
        2>/dev/null) || HTTP_STATUS="000"

    if [[ "$HTTP_STATUS" != "200" ]]; then
        log_fail "Heartbeat returned HTTP $HTTP_STATUS (expected 200)"
        if [[ -s "$HB_BODY_FILE" ]]; then
            BODY_PREVIEW=$(head -c 200 "$HB_BODY_FILE")
            log_info "Response (first 200 chars): ${BODY_PREVIEW}"
        fi
    else
        log_pass "Heartbeat returned HTTP 200"

        if [[ -n "$PYTHON_CMD" && -n "$PYTHON_HELPER_FILE" ]]; then
            HB_ANALYSIS_FILE=$(make_temp)
            if "$PYTHON_CMD" "$PYTHON_HELPER_FILE" heartbeat < "$HB_BODY_FILE" > "$HB_ANALYSIS_FILE" 2>/dev/null; then
                HB_OK=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field ok < "$HB_ANALYSIS_FILE" 2>/dev/null || echo "")
                HB_FOUND_TS=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field found_timestamp < "$HB_ANALYSIS_FILE" 2>/dev/null || echo "")
                HB_LAG=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field lag_minutes < "$HB_ANALYSIS_FILE" 2>/dev/null || echo "")
                HB_FIELD=$("$PYTHON_CMD" "$PYTHON_HELPER_FILE" field timestamp_field < "$HB_ANALYSIS_FILE" 2>/dev/null || echo "")

                log_info "Heartbeat ok: ${HB_OK:-unknown}"

                if [[ "$HB_OK" == "False" ]]; then
                    log_warn "Heartbeat reports ok=false (check job health)"
                fi

                if [[ "$HB_FOUND_TS" == "True" ]]; then
                    log_info "Found timestamp in field: ${HB_FIELD:-unknown}"
                    log_info "Lag: ${HB_LAG:-unknown} minutes"

                    if [[ -n "$HB_LAG" && "$HB_LAG" != "None" && "$HB_LAG" != "null" ]]; then
                        LAG_INT=$(safe_int "$HB_LAG")
                        if [[ "$LAG_INT" -gt "$MAX_ALLOWED_INGEST_LAG_MINUTES" ]]; then
                            log_fail "Heartbeat timestamp lag (${HB_LAG} min) exceeds threshold (${MAX_ALLOWED_INGEST_LAG_MINUTES} min)"
                        else
                            log_pass "Heartbeat timestamp lag within acceptable range"
                        fi
                    fi
                else
                    log_warn "No usable timestamp field found in heartbeat response"
                fi
            else
                log_warn "Failed to parse heartbeat response"
            fi
        else
            log_warn "Python unavailable - JSON freshness parsing skipped"
            log_info "HTTP 200 received but cannot parse response details"
        fi
    fi
fi

# =============================================================================
# Section C: Database Ingestion Gap Detection
# =============================================================================

log_header "Section C: Database Ingestion Gap Detection"

if [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]]; then
    log_skip "Network limit already reached"
elif [[ -z "${DATABASE_URL:-}" ]]; then
    log_skip "DATABASE_URL not set - skipping database checks"
elif ! command -v psql &>/dev/null; then
    log_skip "psql not installed - skipping database checks"
elif ! check_network_limit; then
    log_skip "Network limit reached"
else
    log_info "Connecting to database (read-only)..."

    TABLE_INPUT="${TRADES_TABLE:-}"
    TS_COL="${TRADES_TS_COLUMN:-}"

    # Auto-detect table if not specified
    if [[ -z "$TABLE_INPUT" ]]; then
        log_info "TRADES_TABLE not set, attempting auto-detection..."

        if [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]] || ! check_network_limit; then
            log_skip "Network limit reached during table detection"
        else
            TABLE_DETECT_SQL="SET statement_timeout = '5s'; SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND (table_name ILIKE '%trade%' OR table_name ILIKE '%fill%' OR table_name ILIKE '%execution%' OR table_name ILIKE '%alert%' OR table_name ILIKE '%event%') LIMIT 1;"

            if DETECTED_TABLE=$(run_psql_row "$TABLE_DETECT_SQL" "table auto-detection"); then
                if [[ -n "$DETECTED_TABLE" ]]; then
                    TABLE_INPUT="$DETECTED_TABLE"
                    log_info "Auto-detected table: $TABLE_INPUT"
                else
                    log_warn "No candidate tables found (trade/fill/execution/alert/event)"
                    log_info "To enable DB checks: export TRADES_TABLE='your_table_name'"
                fi
            else
                log_warn "Table auto-detection query failed"
                log_info "To enable DB checks: export TRADES_TABLE='your_table_name'"
            fi
        fi
    fi

    # Parse and validate table reference
    if [[ -z "$TABLE_INPUT" ]]; then
        log_warn "Cannot determine table - skipping database checks"
        log_info "To enable: export TRADES_TABLE='your_table_name'"
    elif ! parse_table_ref "$TABLE_INPUT"; then
        log_warn "Invalid table reference - skipping database checks"
    else
        QUOTED_TABLE=$(get_quoted_table)
        log_debug "Using table: $QUOTED_TABLE"

        # Auto-detect timestamp column if not specified
        if [[ -z "$TS_COL" ]]; then
            log_info "TRADES_TS_COLUMN not set, attempting auto-detection..."

            if [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]] || ! check_network_limit; then
                log_skip "Network limit reached during column detection"
                TS_COL=""
            else
                COL_DETECT_SQL="SET statement_timeout = '5s'; SELECT column_name FROM information_schema.columns WHERE table_schema = '${PARSED_SCHEMA}' AND table_name = '${PARSED_TABLE}' AND data_type IN ('timestamp with time zone', 'timestamp without time zone') AND (column_name ILIKE '%timestamp%' OR column_name ILIKE '%created%' OR column_name ILIKE '%time%' OR column_name = 'ts') LIMIT 1;"

                if DETECTED_COL=$(run_psql_row "$COL_DETECT_SQL" "column auto-detection"); then
                    if [[ -n "$DETECTED_COL" ]]; then
                        TS_COL="$DETECTED_COL"
                        log_info "Auto-detected timestamp column: $TS_COL"
                    else
                        log_warn "No timestamp columns found in table $TABLE_INPUT"
                        log_info "To enable: export TRADES_TS_COLUMN='your_timestamp_column'"
                    fi
                else
                    log_warn "Column auto-detection query failed"
                    log_info "To enable: export TRADES_TS_COLUMN='your_timestamp_column'"
                fi
            fi
        fi

        # Validate column name
        if [[ -z "$TS_COL" ]]; then
            log_warn "Cannot determine timestamp column - skipping database checks"
            log_info "To enable: export TRADES_TS_COLUMN='your_timestamp_column'"
        elif ! validate_identifier "$TS_COL"; then
            log_fail "Invalid column name (must be alphanumeric/underscore): $TS_COL"
        elif [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]] || ! check_network_limit; then
            log_skip "Network limit reached"
        else
            QUOTED_COL=$(quote_ident "$TS_COL")
            log_info "Analyzing: $QUOTED_TABLE.$QUOTED_COL"

            MAX_TS_STALE=0

            # Query max timestamp
            # Uses CTE to compute MAX once, casts to numeric for round(,1), handles NULL gracefully
            MAX_TS_SQL="SET statement_timeout = '5s'; BEGIN READ ONLY; WITH stats AS (SELECT MAX(${QUOTED_COL}) AS max_ts, COUNT(*) FILTER (WHERE ${QUOTED_COL} >= NOW() - INTERVAL '${LOOKBACK_HOURS} hours') AS rows_in_window FROM ${QUOTED_TABLE}) SELECT COALESCE(max_ts::text, ''), CASE WHEN max_ts IS NULL THEN '-1' ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - max_ts)) / 60.0)::numeric, 1)::text END, rows_in_window::text FROM stats; COMMIT;"

            if MAX_TS_RESULT=$(run_psql_row "$MAX_TS_SQL" "max timestamp query"); then
                MAX_TS=$(echo "$MAX_TS_RESULT" | cut -d'|' -f1)
                LAG_MIN=$(echo "$MAX_TS_RESULT" | cut -d'|' -f2)
                ROW_COUNT=$(echo "$MAX_TS_RESULT" | cut -d'|' -f3)

                LAG_MIN=$(safe_int "$LAG_MIN")
                ROW_COUNT=$(safe_int "$ROW_COUNT")

                log_info "Newest record: ${MAX_TS:-N/A}"
                log_info "Lag: ${LAG_MIN} minutes"
                log_info "Records in last ${LOOKBACK_HOURS}h: ${ROW_COUNT}"

                if [[ -z "$MAX_TS" ]]; then
                    log_fail "No records found in last ${LOOKBACK_HOURS} hours"
                    MAX_TS_STALE=1
                elif [[ "$LAG_MIN" -lt 0 ]]; then
                    log_warn "Could not compute lag"
                elif [[ "$LAG_MIN" -gt "$MAX_ALLOWED_INGEST_LAG_MINUTES" ]]; then
                    log_fail "Data lag (${LAG_MIN} min) exceeds threshold (${MAX_ALLOWED_INGEST_LAG_MINUTES} min)"
                    MAX_TS_STALE=1
                else
                    log_pass "Data lag (${LAG_MIN} min) within acceptable range"
                fi
            else
                log_warn "Failed to query max timestamp from $TABLE_INPUT"
            fi

            # Bucket analysis
            if [[ "$NETWORK_LIMIT_REACHED" -eq 1 ]] || ! check_network_limit; then
                log_skip "Network limit reached - skipping bucket analysis"
            else
                BUCKET_SQL="SET statement_timeout = '10s'; BEGIN READ ONLY; WITH params AS (SELECT ${EXPECTED_INTERVAL_MINUTES}::int AS interval_min, ${LOOKBACK_HOURS}::int AS lookback_hours), aligned AS (SELECT date_trunc('minute', NOW()) - ((EXTRACT(MINUTE FROM NOW())::int % (SELECT interval_min FROM params)) * INTERVAL '1 minute') AS now_aligned), buckets AS (SELECT generate_series((SELECT now_aligned FROM aligned) - ((SELECT lookback_hours FROM params) * INTERVAL '1 hour'), (SELECT now_aligned FROM aligned), ((SELECT interval_min FROM params) || ' minutes')::interval) AS bucket_start), counts AS (SELECT date_trunc('minute', ${QUOTED_COL}) - ((EXTRACT(MINUTE FROM ${QUOTED_COL})::int % (SELECT interval_min FROM params)) * INTERVAL '1 minute') AS bucket, COUNT(*) AS cnt FROM ${QUOTED_TABLE} WHERE ${QUOTED_COL} > (SELECT now_aligned FROM aligned) - ((SELECT lookback_hours FROM params) * INTERVAL '1 hour') AND ${QUOTED_COL} <= (SELECT now_aligned FROM aligned) + ((SELECT interval_min FROM params) * INTERVAL '1 minute') GROUP BY 1), bucket_analysis AS (SELECT b.bucket_start, COALESCE(c.cnt, 0) AS record_count, ROW_NUMBER() OVER (ORDER BY b.bucket_start DESC) AS recency_rank FROM buckets b LEFT JOIN counts c ON b.bucket_start = c.bucket), trailing_stats AS (SELECT (SELECT COUNT(*) FROM bucket_analysis ba1 WHERE ba1.record_count = 0 AND ba1.recency_rank <= COALESCE((SELECT MIN(ba2.recency_rank) - 1 FROM bucket_analysis ba2 WHERE ba2.record_count > 0), (SELECT MAX(recency_rank) FROM bucket_analysis))) AS trailing_empty) SELECT (SELECT COUNT(*) FROM bucket_analysis WHERE record_count = 0)::text, (SELECT COUNT(*) FROM bucket_analysis)::text, (SELECT trailing_empty FROM trailing_stats)::text; COMMIT;"

                if BUCKET_RESULT=$(run_psql_row "$BUCKET_SQL" "bucket analysis"); then
                    if [[ -n "$BUCKET_RESULT" ]]; then
                        EMPTY_BUCKETS=$(safe_int "$(echo "$BUCKET_RESULT" | cut -d'|' -f1)")
                        TOTAL_BUCKETS=$(safe_int "$(echo "$BUCKET_RESULT" | cut -d'|' -f2)")
                        TRAILING_EMPTY=$(safe_int "$(echo "$BUCKET_RESULT" | cut -d'|' -f3)")

                        log_info "Bucket analysis (${EXPECTED_INTERVAL_MINUTES}-min intervals over ${LOOKBACK_HOURS}h):"
                        log_info "  Total buckets: ${TOTAL_BUCKETS}"
                        log_info "  Empty buckets: ${EMPTY_BUCKETS}"
                        log_info "  Trailing empty (at now): ${TRAILING_EMPTY}"

                        if [[ "$TOTAL_BUCKETS" -gt 0 ]]; then
                            TRAILING_GAP_MIN=$((TRAILING_EMPTY * EXPECTED_INTERVAL_MINUTES))
                            log_info "  Trailing gap: ~${TRAILING_GAP_MIN} minutes"

                            if [[ "$TRAILING_GAP_MIN" -gt "$MAX_ALLOWED_INGEST_LAG_MINUTES" ]]; then
                                log_fail "Trailing empty buckets (~${TRAILING_GAP_MIN} min gap) indicate stale data"
                            elif [[ "$EMPTY_BUCKETS" -gt 0 ]]; then
                                EMPTY_PCT=$((EMPTY_BUCKETS * 100 / TOTAL_BUCKETS))
                                if [[ "$EMPTY_PCT" -gt 50 ]]; then
                                    log_warn "High percentage of empty buckets (${EMPTY_PCT}%) - data may be sparse"
                                else
                                    log_info "Some empty buckets (${EMPTY_PCT}%) - possibly normal for low activity periods"
                                    if [[ "${MAX_TS_STALE:-0}" -eq 0 ]]; then
                                        log_pass "Bucket coverage acceptable (max-ts lag is OK)"
                                    fi
                                fi
                            else
                                log_pass "Full bucket coverage - no trailing gaps"
                            fi
                        fi
                    else
                        log_warn "Bucket analysis returned empty result"
                    fi
                else
                    log_warn "Bucket analysis query failed or timed out"
                fi
            fi
        fi
    fi
fi

# =============================================================================
# Summary
# =============================================================================

log_header "Summary"

echo ""
echo "Network calls made: $NETWORK_CALLS / $MAX_NETWORK_CALLS max"
echo "Checks performed:   $CHECKS_RUN"
echo ""

if [[ "$CHECKS_RUN" -eq 0 ]]; then
    echo "========================================="
    echo "  NO CHECKS PERFORMED"
    echo "========================================="
    echo ""
    echo "Missing requirements. Ensure at least one of:"
    echo "  - gh CLI installed and authenticated (for GitHub checks)"
    echo "  - OPS_SECRET set (for heartbeat check)"
    echo "  - DATABASE_URL set with psql available (for DB checks)"
    exit 2
elif [[ "$HAVE_FAIL" -eq 1 ]]; then
    echo "========================================="
    echo "  RESULT: FAIL"
    echo "========================================="
    echo ""
    echo "One or more checks failed. Review output above."
    exit 1
else
    if [[ "$HAVE_WARN" -eq 1 ]]; then
        echo "========================================="
        echo "  RESULT: PASS (with warnings)"
        echo "========================================="
        echo ""
        echo "All critical checks passed but there are warnings."
    else
        echo "========================================="
        echo "  RESULT: PASS"
        echo "========================================="
        echo ""
        echo "All checks passed. Data flow looks healthy."
    fi
    exit 0
fi
