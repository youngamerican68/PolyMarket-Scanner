"""
Process and normalize top traders data from Manus CV JSON output.
Manus CV agent scrapes https://polymarket.com/traders and saves JSON.
This module loads, validates, and normalizes that data.
"""

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.normalize import normalize_trader_entry, normalize_wallet_address


def load_traders_json(file_path: str) -> list[dict]:
    """
    Load traders JSON from file.

    Args:
        file_path: Path to the JSON file

    Returns:
        List of raw trader dictionaries
    """
    path = Path(file_path)

    if not path.exists():
        print(f"[ERROR] Traders JSON file not found: {file_path}")
        return []

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, list):
            print(f"[INFO] Loaded {len(data)} traders from: {file_path}")
            return data
        elif isinstance(data, dict) and "traders" in data:
            traders = data["traders"]
            print(f"[INFO] Loaded {len(traders)} traders from: {file_path}")
            return traders
        else:
            print(f"[ERROR] Unexpected JSON structure in: {file_path}")
            return []

    except json.JSONDecodeError as e:
        print(f"[ERROR] Invalid JSON in {file_path}: {e}")
        return []
    except Exception as e:
        print(f"[ERROR] Failed to load {file_path}: {e}")
        return []


def validate_trader(trader: dict) -> bool:
    """
    Validate that a trader entry has required fields.

    Args:
        trader: Raw trader dictionary

    Returns:
        True if valid, False otherwise
    """
    wallet = trader.get("wallet_address", "")
    username = trader.get("username", "")

    if not wallet and not username:
        return False

    return True


def normalize_traders(raw_traders: list[dict]) -> list[dict]:
    """
    Normalize a list of raw trader entries.

    Args:
        raw_traders: List of raw trader dictionaries

    Returns:
        List of normalized trader dictionaries
    """
    normalized = []
    skipped = 0

    for trader in raw_traders:
        if not validate_trader(trader):
            skipped += 1
            continue

        normalized_trader = normalize_trader_entry(trader)

        if not normalized_trader["wallet_address"] and normalized_trader["username"]:
            normalized_trader["wallet_address"] = normalized_trader["username"]

        normalized.append(normalized_trader)

    if skipped > 0:
        print(f"[WARN] Skipped {skipped} invalid trader entries")

    print(f"[INFO] Normalized {len(normalized)} traders")
    return normalized


def get_top_traders(
    file_path: str = None,
    raw_data: list[dict] = None,
    config: dict = None
) -> list[dict]:
    """
    Main function to get and normalize top traders.

    Either file_path or raw_data must be provided.

    Args:
        file_path: Path to traders JSON file
        raw_data: Raw trader list (alternative to file_path)
        config: Configuration dictionary

    Returns:
        List of normalized trader dictionaries with fields:
        - wallet_address
        - username
        - volume_24h_usd
        - profile_url
    """
    config = config or {}
    local_debug = config.get("LOCAL_DEBUG", False)

    if raw_data is not None:
        raw_traders = raw_data
        print(f"[INFO] Processing {len(raw_traders)} traders from raw data")
    elif file_path:
        raw_traders = load_traders_json(file_path)
    elif local_debug:
        example_path = config.get("example_paths", {}).get(
            "sample_traders",
            "./examples/sample_trader_list.json"
        )
        print(f"[LOCAL_DEBUG] Loading sample traders from: {example_path}")
        raw_traders = load_traders_json(example_path)
    else:
        data_path = config.get("data_paths", {}).get(
            "top_traders",
            "./data/top_traders.json"
        )
        raw_traders = load_traders_json(data_path)

    if not raw_traders:
        print("[WARN] No traders data available")
        return []

    normalized = normalize_traders(raw_traders)

    return normalized


def save_sample_traders(traders: list[dict], output_path: str) -> bool:
    """
    Save traders to a sample JSON file for reference.

    Args:
        traders: List of trader dictionaries
        output_path: Path to save the JSON file

    Returns:
        True if successful, False otherwise
    """
    try:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w", encoding="utf-8") as f:
            json.dump(traders, f, indent=2)

        print(f"[INFO] Saved {len(traders)} traders to: {output_path}")
        return True

    except Exception as e:
        print(f"[ERROR] Failed to save traders: {e}")
        return False


def get_wallet_identifiers(traders: list[dict]) -> list[str]:
    """
    Extract wallet identifiers from traders list.
    Used to generate filenames for activity data.

    Args:
        traders: List of normalized trader dictionaries

    Returns:
        List of wallet address or username strings
    """
    identifiers = []

    for trader in traders:
        wallet = trader.get("wallet_address", "")
        username = trader.get("username", "")
        identifier = wallet if wallet else username

        if identifier:
            identifiers.append(identifier)

    return identifiers


if __name__ == "__main__":
    sample_data = [
        {
            "wallet_address": "0xABC123def456",
            "username": "trader_alpha",
            "volume_24h_usd": 15000.50,
            "profile_url": "https://polymarket.com/@trader_alpha"
        },
        {
            "wallet_address": "0xDEF789ghi012",
            "username": "whale_trader",
            "volume_24h_usd": 250000.00,
            "profile_url": "https://polymarket.com/@whale_trader"
        },
        {
            "wallet_address": "0x123456789abc",
            "username": "consistent_winner",
            "volume_24h_usd": 8500.25,
            "profile_url": "https://polymarket.com/@consistent_winner"
        },
        {
            "wallet_address": "",
            "username": "",
            "volume_24h_usd": 100.0,
            "profile_url": ""
        }
    ]

    print("Testing get_top_traders with sample data:")
    traders = get_top_traders(raw_data=sample_data)

    print(f"\nNormalized {len(traders)} traders:")
    for trader in traders:
        print(f"  - {trader['username']} ({trader['wallet_address'][:16]}...): ${trader['volume_24h_usd']:,.2f}")

    print("\nWallet identifiers:")
    identifiers = get_wallet_identifiers(traders)
    for ident in identifiers:
        print(f"  - {ident}")
