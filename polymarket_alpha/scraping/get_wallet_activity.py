"""
Process and normalize wallet activity data from Manus CV JSON output.
Manus CV agent scrapes https://polymarket.com/@<wallet>?tab=activity
and saves JSON per wallet. This module loads, validates, and normalizes that data.
"""

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.normalize import (
    normalize_trade_entry,
    sanitize_wallet_for_filename,
    ALLOWED_TRADE_TYPES
)


def load_activity_json(file_path: str) -> list[dict]:
    """
    Load wallet activity JSON from file.

    Args:
        file_path: Path to the JSON file

    Returns:
        List of raw trade dictionaries
    """
    path = Path(file_path)

    if not path.exists():
        print(f"[WARN] Activity JSON file not found: {file_path}")
        return []

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, list):
            print(f"[INFO] Loaded {len(data)} activities from: {file_path}")
            return data
        elif isinstance(data, dict):
            if "activities" in data:
                activities = data["activities"]
            elif "trades" in data:
                activities = data["trades"]
            else:
                activities = [data]
            print(f"[INFO] Loaded {len(activities)} activities from: {file_path}")
            return activities
        else:
            print(f"[WARN] Unexpected JSON structure in: {file_path}")
            return []

    except json.JSONDecodeError as e:
        print(f"[ERROR] Invalid JSON in {file_path}: {e}")
        return []
    except Exception as e:
        print(f"[ERROR] Failed to load {file_path}: {e}")
        return []


def normalize_activities(raw_activities: list[dict]) -> list[dict]:
    """
    Normalize a list of raw activity entries.
    Filters to only allowed trade types (Buy, Sell, Redeem).

    Args:
        raw_activities: List of raw activity dictionaries

    Returns:
        List of normalized trade dictionaries
    """
    normalized = []
    skipped = 0

    for activity in raw_activities:
        normalized_trade = normalize_trade_entry(activity)

        if normalized_trade is None:
            skipped += 1
            continue

        normalized.append(normalized_trade)

    if skipped > 0:
        print(f"[INFO] Filtered out {skipped} non-trade activities (not Buy/Sell/Redeem)")

    print(f"[INFO] Normalized {len(normalized)} trades")
    return normalized


def get_activity_file_path(
    wallet_identifier: str,
    config: dict = None
) -> str:
    """
    Generate the expected file path for a wallet's activity JSON.

    Args:
        wallet_identifier: Wallet address or username
        config: Configuration dictionary

    Returns:
        File path string
    """
    config = config or {}
    data_paths = config.get("data_paths", {})

    activity_dir = data_paths.get("wallet_activity_dir", "./data/")
    pattern = data_paths.get("wallet_activity_pattern", "wallet_activity_{wallet}.json")

    sanitized_wallet = sanitize_wallet_for_filename(wallet_identifier)

    filename = pattern.format(wallet=sanitized_wallet)

    return str(Path(activity_dir) / filename)


def get_wallet_activity(
    wallet_identifier: str,
    file_path: str = None,
    raw_data: list[dict] = None,
    config: dict = None
) -> list[dict]:
    """
    Get and normalize activity data for a single wallet.

    Args:
        wallet_identifier: Wallet address or username
        file_path: Path to activity JSON file (optional)
        raw_data: Raw activity list (alternative to file_path)
        config: Configuration dictionary

    Returns:
        List of normalized trade dictionaries with fields:
        - type (Buy, Sell, or Redeem)
        - market_name
        - amount_usd
        - timestamp
        - resolved_outcome
        - payout_usd
    """
    config = config or {}

    if raw_data is not None:
        raw_activities = raw_data
        print(f"[INFO] Processing {len(raw_activities)} activities from raw data for {wallet_identifier}")
    elif file_path:
        raw_activities = load_activity_json(file_path)
    else:
        generated_path = get_activity_file_path(wallet_identifier, config)
        raw_activities = load_activity_json(generated_path)

    if not raw_activities:
        print(f"[WARN] No activity data for wallet: {wallet_identifier}")
        return []

    normalized = normalize_activities(raw_activities)

    return normalized


def get_all_wallet_activities(
    wallet_identifiers: list[str],
    config: dict = None
) -> dict[str, list[dict]]:
    """
    Get normalized activity data for multiple wallets.

    Args:
        wallet_identifiers: List of wallet addresses or usernames
        config: Configuration dictionary

    Returns:
        Dictionary mapping wallet identifiers to their normalized trades
    """
    config = config or {}
    results = {}

    print(f"[INFO] Loading activities for {len(wallet_identifiers)} wallets...")

    for wallet in wallet_identifiers:
        activities = get_wallet_activity(wallet, config=config)
        results[wallet] = activities

    loaded_count = sum(1 for v in results.values() if v)
    print(f"[INFO] Successfully loaded activities for {loaded_count}/{len(wallet_identifiers)} wallets")

    return results


def save_sample_activity(activities: list[dict], output_path: str) -> bool:
    """
    Save activities to a sample JSON file for reference.

    Args:
        activities: List of activity dictionaries
        output_path: Path to save the JSON file

    Returns:
        True if successful, False otherwise
    """
    try:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w", encoding="utf-8") as f:
            json.dump(activities, f, indent=2)

        print(f"[INFO] Saved {len(activities)} activities to: {output_path}")
        return True

    except Exception as e:
        print(f"[ERROR] Failed to save activities: {e}")
        return False


def build_wallet_data_for_claude(
    wallet_identifier: str,
    username: str,
    trades: list[dict]
) -> dict:
    """
    Build the wallet data structure expected by Claude.

    Args:
        wallet_identifier: Wallet address
        username: Username
        trades: List of normalized trades

    Returns:
        Wallet dictionary in Claude's expected format
    """
    return {
        "wallet_address": wallet_identifier,
        "username": username,
        "trades": trades
    }


if __name__ == "__main__":
    sample_activities = [
        {
            "type": "Buy",
            "market_name": "Will BTC be above 100k by 2025?",
            "amount_usd": 150.0,
            "timestamp": "2025-01-02T13:45:00Z",
            "resolved_outcome": "Yes",
            "payout_usd": 220.0
        },
        {
            "type": "Buy",
            "market_name": "Will ETH flip BTC?",
            "amount_usd": 100.0,
            "timestamp": "2025-01-01T10:00:00Z",
            "resolved_outcome": "No",
            "payout_usd": 0.0
        },
        {
            "type": "Sell",
            "market_name": "Market pullback in Jan?",
            "amount_usd": 50.0,
            "timestamp": "2025-01-02T09:00:00Z",
            "resolved_outcome": None,
            "payout_usd": 0.0
        },
        {
            "type": "Redeem",
            "market_name": "Trump wins 2024?",
            "amount_usd": 0.0,
            "timestamp": "2024-12-28T08:00:00Z",
            "resolved_outcome": "Yes",
            "payout_usd": 350.0
        },
        {
            "type": "Deposit",
            "market_name": "",
            "amount_usd": 1000.0,
            "timestamp": "2024-12-25T00:00:00Z",
            "resolved_outcome": None,
            "payout_usd": 0.0
        },
        {
            "type": "Withdraw",
            "market_name": "",
            "amount_usd": 500.0,
            "timestamp": "2024-12-26T00:00:00Z",
            "resolved_outcome": None,
            "payout_usd": 0.0
        }
    ]

    print("Testing get_wallet_activity with sample data:")
    activities = get_wallet_activity(
        "0xtest123",
        raw_data=sample_activities
    )

    print(f"\nNormalized {len(activities)} trades (filtered from {len(sample_activities)} activities):")
    for trade in activities:
        print(f"  - [{trade['type']}] {trade['market_name'][:40]}... | ${trade['amount_usd']:.2f}")

    print("\nBuilding wallet data for Claude:")
    wallet_data = build_wallet_data_for_claude(
        "0xtest123",
        "test_trader",
        activities
    )
    print(f"  Wallet: {wallet_data['wallet_address']}")
    print(f"  Username: {wallet_data['username']}")
    print(f"  Trades: {len(wallet_data['trades'])}")
