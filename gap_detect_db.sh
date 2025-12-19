#!/usr/bin/env bash
#
# gap_detect_db.sh - Simplified DB-only gap detection
#
# USAGE:
#   # Dashboard alert_events monitoring (recommended for Polymarket Scanner)
#   DATABASE_URL="postgres://..." TRADES_TABLE="alert_events" TRADES_TS_COLUMN="fill_timestamp" ./gap_detect_db.sh
#
#   # Schema-qualified table
#   DATABASE_URL="..." TRADES_TABLE="myschema.trades" TRADES_TS_COLUMN="created_at" ./gap_detect_db.sh
#
#   # Debug mode (shows SQL, detailed errors)
#   DEBUG=1 DATABASE_URL="..." TRADES_TABLE="alert_events" TRADES_TS_COLUMN="fill_timestamp" ./gap_detect_db.sh
#
#   # Connection test only (does not require table/column)
#   CHECK_CONNECTION=1 DATABASE_URL="..." ./gap_detect_db.sh
#
# ENVIRONMENT VARIABLES:
#   DATABASE_URL                    Postgres connection string (required)
#   TRADES_TABLE                    Table name, optionally schema-qualified (required unless CHECK_CONNECTION=1)
#   TRADES_TS_COLUMN                Timestamp column name (required unless CHECK_CONNECTION=1)
#   DEBUG                           Set to 1 for verbose output (SQL queries, full errors)
#   CHECK_CONNECTION                Set to 1 to test DB connection only
#   EXPECTED_INTERVAL_MINUTES       Expected data interval (default: 5)
#   MAX_ALLOWED_INGEST_LAG_MINUTES  Max acceptable data lag (default: 20)
#   LOOKBACK_HOURS                  Hours of data to analyze (default: 6)
#
# EXIT CODES:
#   0 - All checks PASS
#   1 - Detected gap/lag problem (script completed successfully, found an issue)
#   2 - Configuration/runtime error (missing env, cannot connect, etc.)
#
set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================
readonly EXPECTED_INTERVAL_MINUTES="${EXPECTED_INTERVAL_MINUTES:-5}"
readonly LOOKBACK_HOURS="${LOOKBACK_HOURS:-6}"
readonly MAX_ALLOWED_INGEST_LAG_MINUTES="${MAX_ALLOWED_INGEST_LAG_MINUTES:-20}"
readonly DEBUG="${DEBUG:-0}"
readonly CHECK_CONNECTION="${CHECK_CONNECTION:-0}"

# Validate numeric configs (prevent SQL injection via config vars)
validate_positive_int() {
    local val="$1" name="$2"
    if [[ ! "$val" =~ ^[0-9]+$ ]] || [[ "$val" -eq 0 ]]; then
        echo "[FAIL] $name must be a positive integer: got '$val'" >&2
        exit 2
    fi
}
validate_positive_int "$EXPECTED_INTERVAL_MINUTES" "EXPECTED_INTERVAL_MINUTES"
validate_positive_int "$LOOKBACK_HOURS" "LOOKBACK_HOURS"
validate_positive_int "$MAX_ALLOWED_INGEST_LAG_MINUTES" "MAX_ALLOWED_INGEST_LAG_MINUTES"

# =============================================================================
# Temp file management
# =============================================================================
declare -a TEMP_FILES=()

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
}

log_fail() {
    echo "[FAIL] $1"
}

log_pass() {
    echo "[PASS] $1"
}

# =============================================================================
# Utility functions
# =============================================================================

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

# =============================================================================
# Identifier validation and quoting
# =============================================================================

# Validates identifier: letters, digits, underscore only
validate_identifier() {
    local val="$1"
    [[ "$val" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

# Parse table reference: "table" or "schema.table"
# Sets PARSED_SCHEMA and PARSED_TABLE globals
parse_table_ref() {
    local ref="$1"
    PARSED_SCHEMA=""
    PARSED_TABLE=""

    # Check for unsafe characters
    if [[ "$ref" =~ [\"\'\;\$\`\\] ]]; then
        log_fail "Table reference contains unsafe characters: $ref"
        return 1
    fi

    if [[ "$ref" == *.* ]]; then
        PARSED_SCHEMA="${ref%%.*}"
        PARSED_TABLE="${ref#*.}"

        if ! validate_identifier "$PARSED_SCHEMA"; then
            log_fail "Invalid schema name (must be alphanumeric/underscore): $PARSED_SCHEMA"
            return 1
        fi
        if ! validate_identifier "$PARSED_TABLE"; then
            log_fail "Invalid table name (must be alphanumeric/underscore): $PARSED_TABLE"
            return 1
        fi
    else
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
            local snippet
            snippet=$(tail -5 "$stderr_file" 2>/dev/null || true)
            if [[ -n "$snippet" ]]; then
                log_info "DB error: $snippet"
            fi

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

# =============================================================================
# Pre-flight checks
# =============================================================================

# Check psql
if ! command -v psql >/dev/null 2>&1; then
    log_fail "psql not installed"
    exit 2
fi

# Check DATABASE_URL
if [[ -z "${DATABASE_URL:-}" ]]; then
    log_fail "DATABASE_URL is required"
    log_info "Format: postgres://user:password@host:port/dbname"
    exit 2
fi

# =============================================================================
# CHECK_CONNECTION mode
# =============================================================================
if [[ "$CHECK_CONNECTION" == "1" ]]; then
    echo "Connection Test Mode"
    echo "===================="
    echo ""
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
# Validate required env vars for non-connection mode
# =============================================================================
if [[ -z "${TRADES_TABLE:-}" ]]; then
    log_fail "TRADES_TABLE is required"
    log_info "Example: export TRADES_TABLE='trades' or TRADES_TABLE='myschema.trades'"
    exit 2
fi

if [[ -z "${TRADES_TS_COLUMN:-}" ]]; then
    log_fail "TRADES_TS_COLUMN is required"
    log_info "Example: export TRADES_TS_COLUMN='timestamp' or TRADES_TS_COLUMN='created_at'"
    exit 2
fi

# Parse and validate table reference
if ! parse_table_ref "$TRADES_TABLE"; then
    exit 2
fi

QUOTED_TABLE=$(get_quoted_table)

# Validate column name
if ! validate_identifier "$TRADES_TS_COLUMN"; then
    log_fail "Invalid column name (must be alphanumeric/underscore): $TRADES_TS_COLUMN"
    exit 2
fi

QUOTED_COL=$(quote_ident "$TRADES_TS_COLUMN")

# =============================================================================
# Main
# =============================================================================

echo "DB Gap Check"
echo "============"
echo ""
echo "Configuration:"
echo "  Schema:       $PARSED_SCHEMA"
echo "  Table:        $PARSED_TABLE"
echo "  Column:       $TRADES_TS_COLUMN"
echo "  Lookback:     ${LOOKBACK_HOURS}h"
echo "  Interval:     ${EXPECTED_INTERVAL_MINUTES}m"
echo "  Max lag:      ${MAX_ALLOWED_INGEST_LAG_MINUTES}m"
echo "  DEBUG:        $DEBUG"
echo ""

# Query 1: Max timestamp and lag
# Uses CTE to compute MAX once, casts to numeric for round(,1), handles NULL gracefully
MAX_SQL="SET statement_timeout = '8s'; BEGIN READ ONLY; WITH stats AS (SELECT MAX(${QUOTED_COL}) AS max_ts, COUNT(*) FILTER (WHERE ${QUOTED_COL} >= NOW() - INTERVAL '${LOOKBACK_HOURS} hours') AS rows_in_window FROM ${QUOTED_TABLE}) SELECT COALESCE(max_ts::text, ''), CASE WHEN max_ts IS NULL THEN '' ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - max_ts)) / 60.0)::numeric, 1)::text END, rows_in_window::text FROM stats; COMMIT;"

if ! MAX_LINE=$(run_psql_row "$MAX_SQL" "max timestamp query"); then
    log_fail "Could not query max timestamp"
    exit 2
fi

MAX_TS=$(echo "$MAX_LINE" | cut -d'|' -f1)
LAG_MIN=$(echo "$MAX_LINE" | cut -d'|' -f2)
ROWS=$(echo "$MAX_LINE" | cut -d'|' -f3)

log_info "Newest record: ${MAX_TS:-N/A}"
log_info "Lag minutes:   ${LAG_MIN:-N/A}"
log_info "Rows in window: ${ROWS:-N/A}"
echo ""

if [[ -z "${MAX_TS:-}" ]]; then
    log_fail "No records in the last ${LOOKBACK_HOURS} hours"
    exit 1
fi

# Parse lag as integer
LAG_INT=$(safe_int "$LAG_MIN")

if [[ "$LAG_INT" -gt "$MAX_ALLOWED_INGEST_LAG_MINUTES" ]]; then
    log_fail "Data is stale (lag ${LAG_MIN} min > ${MAX_ALLOWED_INGEST_LAG_MINUTES} min)"
    exit 1
else
    log_pass "Freshness OK (lag ${LAG_MIN} min <= ${MAX_ALLOWED_INGEST_LAG_MINUTES} min)"
fi

echo ""
echo "Bucket coverage / trailing gap analysis..."

# Query 2: Bucket analysis
BUCKET_SQL="SET statement_timeout = '12s'; BEGIN READ ONLY; WITH params AS (SELECT ${EXPECTED_INTERVAL_MINUTES}::int AS interval_min, ${LOOKBACK_HOURS}::int AS lookback_hours), aligned AS (SELECT date_trunc('minute', NOW()) - ((EXTRACT(MINUTE FROM NOW())::int % (SELECT interval_min FROM params)) * INTERVAL '1 minute') AS now_aligned), buckets AS (SELECT generate_series((SELECT now_aligned FROM aligned) - ((SELECT lookback_hours FROM params) * INTERVAL '1 hour'), (SELECT now_aligned FROM aligned), ((SELECT interval_min FROM params) || ' minutes')::interval) AS bucket_start), counts AS (SELECT date_trunc('minute', ${QUOTED_COL}) - ((EXTRACT(MINUTE FROM ${QUOTED_COL})::int % (SELECT interval_min FROM params)) * INTERVAL '1 minute') AS bucket, COUNT(*) AS cnt FROM ${QUOTED_TABLE} WHERE ${QUOTED_COL} > (SELECT now_aligned FROM aligned) - ((SELECT lookback_hours FROM params) * INTERVAL '1 hour') AND ${QUOTED_COL} <= (SELECT now_aligned FROM aligned) + ((SELECT interval_min FROM params) * INTERVAL '1 minute') GROUP BY 1), ba AS (SELECT b.bucket_start, COALESCE(c.cnt, 0) AS record_count, ROW_NUMBER() OVER (ORDER BY b.bucket_start DESC) AS recency_rank FROM buckets b LEFT JOIN counts c ON b.bucket_start = c.bucket), trailing AS (SELECT COUNT(*) AS trailing_empty FROM ba WHERE record_count = 0 AND recency_rank <= COALESCE((SELECT MIN(recency_rank) - 1 FROM ba WHERE record_count > 0), (SELECT MAX(recency_rank) FROM ba))) SELECT (SELECT COUNT(*) FROM ba WHERE record_count = 0)::text AS empty_buckets, (SELECT COUNT(*) FROM ba)::text AS total_buckets, (SELECT trailing_empty FROM trailing)::text AS trailing_empty; COMMIT;"

if ! BUCKET_LINE=$(run_psql_row "$BUCKET_SQL" "bucket analysis"); then
    log_warn "Bucket analysis query failed (timeout or permissions). Freshness check above is still valid."
    exit 0
fi

EMPTY=$(echo "$BUCKET_LINE" | cut -d'|' -f1)
TOTAL=$(echo "$BUCKET_LINE" | cut -d'|' -f2)
TRAILING_EMPTY=$(echo "$BUCKET_LINE" | cut -d'|' -f3)

EMPTY=$(safe_int "$EMPTY")
TOTAL=$(safe_int "$TOTAL")
TRAILING_EMPTY=$(safe_int "$TRAILING_EMPTY")

TRAILING_GAP_MIN=$(( TRAILING_EMPTY * EXPECTED_INTERVAL_MINUTES ))

log_info "Total buckets:   $TOTAL"
log_info "Empty buckets:   $EMPTY"
log_info "Trailing empty:  $TRAILING_EMPTY"
log_info "Trailing gap:   ~${TRAILING_GAP_MIN} minutes"
echo ""

if [[ "$TRAILING_GAP_MIN" -gt "$MAX_ALLOWED_INGEST_LAG_MINUTES" ]]; then
    log_fail "Trailing gap indicates stale ingestion (~${TRAILING_GAP_MIN} min > ${MAX_ALLOWED_INGEST_LAG_MINUTES} min)"
    exit 1
else
    log_pass "No problematic trailing gap"
    exit 0
fi
