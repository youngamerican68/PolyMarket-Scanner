"""
Normalize and clean trade data and timestamps.
Includes robust CSV parsing for Claude's output.
"""

from __future__ import annotations

import re
import csv
import io
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


ALLOWED_TRADE_TYPES = {"Buy", "Sell", "Redeem"}


def normalize_timestamp(timestamp_str: str) -> datetime:
    """
    Parse a timestamp string into a datetime object.
    Supports ISO 8601 format with or without timezone.

    Args:
        timestamp_str: Timestamp string (e.g., "2025-01-02T13:45:00Z")

    Returns:
        datetime object in UTC
    """
    if not timestamp_str:
        return datetime.now(timezone.utc)

    timestamp_str = timestamp_str.strip()

    formats_to_try = [
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ]

    for fmt in formats_to_try:
        try:
            dt = datetime.strptime(timestamp_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue

    print(f"[WARN] Could not parse timestamp: {timestamp_str}, using current time")
    return datetime.now(timezone.utc)


def normalize_trade_type(trade_type: str) -> Optional[str]:
    """
    Normalize trade type to one of the allowed types.

    Args:
        trade_type: Raw trade type string

    Returns:
        Normalized trade type or None if not allowed
    """
    if not trade_type:
        return None

    normalized = trade_type.strip().capitalize()

    if normalized in ALLOWED_TRADE_TYPES:
        return normalized

    return None


def normalize_usd_value(value: Any) -> float:
    """
    Normalize USD value to a float.

    Args:
        value: Raw value (str, int, float, or None)

    Returns:
        Float value, 0.0 if invalid
    """
    if value is None:
        return 0.0

    if isinstance(value, (int, float)):
        return float(value)

    if isinstance(value, str):
        cleaned = value.strip().replace("$", "").replace(",", "")
        try:
            return float(cleaned)
        except ValueError:
            print(f"[WARN] Could not parse USD value: {value}")
            return 0.0

    return 0.0


def normalize_wallet_address(address: str) -> str:
    """
    Normalize wallet address format.

    Args:
        address: Raw wallet address

    Returns:
        Normalized wallet address (lowercase, trimmed)
    """
    if not address:
        return ""

    return address.strip().lower()


def sanitize_wallet_for_filename(wallet_address: str) -> str:
    """
    Sanitize wallet address for use in filenames.

    Args:
        wallet_address: Wallet address

    Returns:
        Safe filename string
    """
    sanitized = re.sub(r'[^a-zA-Z0-9]', '_', wallet_address)
    if len(sanitized) > 50:
        sanitized = sanitized[:50]
    return sanitized


def normalize_trade_entry(trade: dict) -> Optional[dict]:
    """
    Normalize a single trade entry from raw Manus JSON.

    Args:
        trade: Raw trade dictionary

    Returns:
        Normalized trade dictionary or None if invalid
    """
    trade_type = normalize_trade_type(trade.get("type", ""))

    if trade_type is None:
        return None

    normalized = {
        "type": trade_type,
        "market_name": str(trade.get("market_name", "")).strip(),
        "amount_usd": normalize_usd_value(trade.get("amount_usd")),
        "timestamp": normalize_timestamp(trade.get("timestamp", "")).isoformat(),
        "resolved_outcome": str(trade.get("resolved_outcome", "")).strip() or None,
        "payout_usd": normalize_usd_value(trade.get("payout_usd")),
    }

    return normalized


def normalize_trader_entry(trader: dict) -> dict:
    """
    Normalize a single trader entry from raw Manus JSON.

    Args:
        trader: Raw trader dictionary

    Returns:
        Normalized trader dictionary
    """
    return {
        "wallet_address": normalize_wallet_address(trader.get("wallet_address", "")),
        "username": str(trader.get("username", "")).strip(),
        "volume_24h_usd": normalize_usd_value(trader.get("volume_24h_usd")),
        "profile_url": str(trader.get("profile_url", "")).strip(),
    }


def parse_claude_csv_output(csv_text: str) -> List[List[str]]:
    """
    Robustly parse CSV output from Claude's response.

    Features:
    - Ignores blank lines
    - Strips whitespace around fields
    - Logs and skips malformed rows
    - Continues processing remaining rows on error

    Args:
        csv_text: Raw CSV text from Claude's response

    Returns:
        List of rows, where each row is a list of field values
    """
    if not csv_text:
        print("[WARN] Empty CSV text provided")
        return []

    lines = csv_text.strip().split("\n")

    non_empty_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped:
            non_empty_lines.append(stripped)

    if not non_empty_lines:
        print("[WARN] No non-empty lines in CSV text")
        return []

    expected_columns = None
    rows = []

    for i, line in enumerate(non_empty_lines):
        try:
            reader = csv.reader(io.StringIO(line))
            parsed_row = next(reader)

            cleaned_row = [field.strip() for field in parsed_row]

            if expected_columns is None:
                expected_columns = len(cleaned_row)
                print(f"[INFO] CSV header detected with {expected_columns} columns")

            if len(cleaned_row) != expected_columns:
                print(f"[WARN] Line {i+1}: Expected {expected_columns} columns, got {len(cleaned_row)}. Skipping: {line[:100]}")
                continue

            rows.append(cleaned_row)

        except csv.Error as e:
            print(f"[WARN] Line {i+1}: CSV parse error - {e}. Skipping: {line[:100]}")
            continue
        except StopIteration:
            print(f"[WARN] Line {i+1}: Empty after parsing. Skipping.")
            continue

    print(f"[INFO] Successfully parsed {len(rows)} rows from CSV")
    return rows


def extract_csv_block_from_claude_response(response_text: str) -> str:
    """
    Extract the CSV block from Claude's full response.
    Looks for content between ```csv and ``` markers.

    Args:
        response_text: Full Claude response text

    Returns:
        Extracted CSV text or empty string if not found
    """
    csv_pattern = r'```csv\s*([\s\S]*?)\s*```'
    match = re.search(csv_pattern, response_text, re.IGNORECASE)

    if match:
        return match.group(1).strip()

    code_pattern = r'```\s*([\s\S]*?)\s*```'
    matches = re.findall(code_pattern, response_text)

    for block in matches:
        lines = block.strip().split("\n")
        if lines and "," in lines[0]:
            return block.strip()

    print("[WARN] No CSV block found in Claude response")
    return ""


def extract_markdown_block_from_claude_response(response_text: str) -> str:
    """
    Extract the Markdown table/report from Claude's response.
    Takes content before the CSV block.

    Args:
        response_text: Full Claude response text

    Returns:
        Markdown portion of the response
    """
    csv_marker = re.search(r'```csv', response_text, re.IGNORECASE)

    if csv_marker:
        markdown_part = response_text[:csv_marker.start()].strip()
    else:
        code_marker = re.search(r'```', response_text)
        if code_marker:
            markdown_part = response_text[:code_marker.start()].strip()
        else:
            markdown_part = response_text.strip()

    return markdown_part


def build_claude_input_json(as_of_date: str, wallets_data: List[dict]) -> dict:
    """
    Build the JSON structure expected by Claude for analysis.

    Args:
        as_of_date: Date string (YYYY-MM-DD)
        wallets_data: List of wallet dictionaries with trades

    Returns:
        Properly structured JSON for Claude
    """
    return {
        "as_of_date": as_of_date,
        "wallets": wallets_data
    }


if __name__ == "__main__":
    test_csv = """date,wallet_address,username,profit_7d,roi,win_rate,consistency_score,flags
2025-01-02,0xabc123,trader1,500.00,0.25,0.75,85,HighProfit|HighConsistency
2025-01-02,0xdef456,trader2,150.00,0.10,0.60,65,

2025-01-02,0xghi789,trader3,1200.00,0.40,0.95,92,HighProfit|SuspiciouslyAccurate
"""

    print("Testing CSV parser:")
    rows = parse_claude_csv_output(test_csv)
    for row in rows:
        print(f"  {row}")

    print("\nTesting timestamp parser:")
    timestamps = [
        "2025-01-02T13:45:00Z",
        "2025-01-02T13:45:00.123Z",
        "2025-01-02",
    ]
    for ts in timestamps:
        print(f"  {ts} -> {normalize_timestamp(ts)}")
