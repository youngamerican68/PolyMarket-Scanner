#!/usr/bin/env python3
"""
Polymarket Trader Activity Monitor

Monitors a specific trader's Activity tab and extracts structured trading data
from the last 24 hours. Flags Google-related trades and multi-trade patterns.

Usage:
    python monitor_trader_activity.py --wallet 0xafEe
    python monitor_trader_activity.py --url "https://polymarket.com/@trader_name?tab=activity"
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.logging_config import get_logger

logger = get_logger(__name__)

# Google-related keywords for flagging
GOOGLE_KEYWORDS = [
    # Corporate entities
    "google", "google's", "alphabet", "deepmind", "verily", "waymo", "isomorphic labs",
    # AI/Search products
    "gemini", "bard", "lamda", "palm", "google search", "top searched", "most searched",
    # Hardware
    "pixel", "nest",
    # Platforms
    "youtube", "android", "chrome", "chromebook",
]

# Valid trade types to include
VALID_TRADE_TYPES = {"buy", "sell", "redeem"}

# Trade types to exclude
EXCLUDED_TRADE_TYPES = {"reward", "claim", "transfer"}


def is_google_related(market_text: str) -> bool:
    """
    Check if market text contains Google-related keywords.

    Args:
        market_text: The market description text

    Returns:
        True if Google-related, False otherwise
    """
    if not market_text:
        return False

    market_lower = market_text.lower()

    for keyword in GOOGLE_KEYWORDS:
        if keyword.lower() in market_lower:
            return True

    # Special case: "ranking" when referring to search rankings
    if "ranking" in market_lower and any(
        term in market_lower for term in ["search", "top", "most"]
    ):
        return True

    return False


def parse_timestamp(timestamp_str: str, current_time: datetime) -> Optional[datetime]:
    """
    Parse various timestamp formats from Polymarket.

    Args:
        timestamp_str: Timestamp string (e.g., "2 hours ago", "Dec 5", "12:30 PM")
        current_time: Current datetime for relative calculations

    Returns:
        Parsed datetime or None if unparseable
    """
    if not timestamp_str:
        return None

    timestamp_str = timestamp_str.strip().lower()

    # Relative timestamps
    if "ago" in timestamp_str:
        # "2 hours ago", "30 minutes ago", "1 day ago"
        match = re.search(r"(\d+)\s*(second|minute|hour|day|week)s?\s*ago", timestamp_str)
        if match:
            value = int(match.group(1))
            unit = match.group(2)

            if unit == "second":
                return current_time - timedelta(seconds=value)
            elif unit == "minute":
                return current_time - timedelta(minutes=value)
            elif unit == "hour":
                return current_time - timedelta(hours=value)
            elif unit == "day":
                return current_time - timedelta(days=value)
            elif unit == "week":
                return current_time - timedelta(weeks=value)

    # "just now"
    if "just now" in timestamp_str:
        return current_time

    # Try parsing absolute formats
    formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ",
        "%b %d, %Y",
        "%b %d",
        "%m/%d/%Y",
    ]

    for fmt in formats:
        try:
            parsed = datetime.strptime(timestamp_str, fmt)
            # If no year, assume current year
            if parsed.year == 1900:
                parsed = parsed.replace(year=current_time.year)
            return parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    return None


def is_within_24_hours(trade_time: datetime, current_time: datetime) -> bool:
    """Check if trade occurred within last 24 hours."""
    if not trade_time:
        return False

    cutoff = current_time - timedelta(hours=24)
    return trade_time >= cutoff


def extract_trades_from_activity(
    activity_data: List[Dict[str, Any]],
    current_time: datetime,
) -> List[Dict[str, Any]]:
    """
    Extract and filter trades from activity data.

    Args:
        activity_data: Raw activity data from scraping
        current_time: Current datetime

    Returns:
        List of filtered and processed trades
    """
    trades = []

    for item in activity_data:
        # Get trade type
        trade_type = item.get("type", "").lower().strip()

        # Skip excluded types
        if trade_type in EXCLUDED_TRADE_TYPES:
            continue

        # Only include valid trade types
        if trade_type not in VALID_TRADE_TYPES:
            continue

        # Parse timestamp
        timestamp_str = item.get("timestamp", item.get("time", ""))
        trade_time = parse_timestamp(timestamp_str, current_time)

        # Only include trades from last 24 hours
        if not is_within_24_hours(trade_time, current_time):
            continue

        # Extract fields
        market = item.get("market", item.get("title", "Unknown"))
        amount = item.get("amount", item.get("value", "Unknown"))

        trades.append({
            "time": trade_time,
            "time_str": timestamp_str if timestamp_str else "Unknown",
            "type": trade_type.capitalize(),
            "market": market,
            "amount": amount,
            "google_related": is_google_related(market),
        })

    return trades


def flag_multi_trades(trades: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Flag trades that have multiple entries in the same market.

    Args:
        trades: List of trade dictionaries

    Returns:
        Trades with multi_trade_same_market flag added
    """
    # Count trades per market
    market_counts: Dict[str, int] = {}
    for trade in trades:
        market = trade.get("market", "")
        market_counts[market] = market_counts.get(market, 0) + 1

    # Flag trades
    for trade in trades:
        market = trade.get("market", "")
        trade["multi_trade_same_market"] = market_counts.get(market, 0) > 1

    return trades


def format_markdown_report(
    trades: List[Dict[str, Any]],
    trader_url: str,
    current_time: datetime,
) -> str:
    """
    Generate markdown report for trader activity.

    Args:
        trades: List of processed trades
        trader_url: URL of the trader's profile
        current_time: Current datetime

    Returns:
        Formatted markdown report
    """
    lines = [
        f"# Trader Activity Report",
        f"",
        f"**Trader URL:** {trader_url}",
        f"**Report Generated:** {current_time.strftime('%Y-%m-%d %H:%M:%S UTC')}",
        f"**Time Window:** Last 24 hours",
        f"",
    ]

    if not trades:
        lines.append("**No trades in the last 24 hours for this trader.**")
        return "\n".join(lines)

    # Sort trades newest to oldest
    trades_sorted = sorted(
        trades,
        key=lambda x: x.get("time") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )

    # Add table header
    lines.extend([
        "## Trades",
        "",
        "| Time | Type | Market | Amount | GoogleRelated | MultiTradeSameMarketLast24H |",
        "|------|------|--------|--------|---------------|----------------------------|",
    ])

    # Add trade rows
    for trade in trades_sorted:
        time_str = trade.get("time_str", "Unknown")
        trade_type = trade.get("type", "Unknown")
        market = trade.get("market", "Unknown")
        amount = trade.get("amount", "Unknown")
        google_flag = "Yes" if trade.get("google_related") else "No"
        multi_flag = "Yes" if trade.get("multi_trade_same_market") else "No"

        # Truncate long market names for table display
        market_display = market[:50] + "..." if len(market) > 50 else market

        lines.append(
            f"| {time_str} | {trade_type} | {market_display} | {amount} | {google_flag} | {multi_flag} |"
        )

    # Summary section
    total_trades = len(trades)
    google_trades = sum(1 for t in trades if t.get("google_related"))

    # Count markets with multiple trades
    market_counts: Dict[str, int] = {}
    for trade in trades:
        market = trade.get("market", "")
        market_counts[market] = market_counts.get(market, 0) + 1
    multi_trade_markets = sum(1 for count in market_counts.values() if count > 1)

    lines.extend([
        "",
        "## Summary",
        "",
        f"- **Total trades in last 24 hours:** {total_trades}",
        f"- **Google-related trades:** {google_trades}",
        f"- **Markets with multiple trades:** {multi_trade_markets}",
    ])

    return "\n".join(lines)


def save_report(report: str, output_path: str) -> None:
    """Save report to file."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report, encoding="utf-8")
    logger.info(f"Report saved to: {output_path}")


def monitor_trader(
    trader_identifier: str,
    activity_data: Optional[List[Dict[str, Any]]] = None,
    output_path: Optional[str] = None,
) -> str:
    """
    Monitor a trader's activity and generate report.

    Args:
        trader_identifier: Wallet address or username
        activity_data: Pre-loaded activity data (for testing)
        output_path: Optional path to save report

    Returns:
        Markdown report string
    """
    current_time = datetime.now(timezone.utc)

    # Build URL
    if trader_identifier.startswith("http"):
        trader_url = trader_identifier
    elif trader_identifier.startswith("0x"):
        trader_url = f"https://polymarket.com/@{trader_identifier}?tab=activity"
    else:
        trader_url = f"https://polymarket.com/@{trader_identifier}?tab=activity"

    logger.info(f"Monitoring trader: {trader_url}")

    # If no activity data provided, we'd need to scrape it
    # For now, use provided data or empty list
    if activity_data is None:
        logger.warning("No activity data provided. In production, this would scrape the page.")
        activity_data = []

    # Extract and process trades
    trades = extract_trades_from_activity(activity_data, current_time)
    trades = flag_multi_trades(trades)

    logger.info(f"Found {len(trades)} trades in last 24 hours")

    # Generate report
    report = format_markdown_report(trades, trader_url, current_time)

    # Save if output path provided
    if output_path:
        save_report(report, output_path)

    return report


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Monitor Polymarket trader activity"
    )
    parser.add_argument(
        "--wallet",
        type=str,
        help="Wallet address or username to monitor",
    )
    parser.add_argument(
        "--url",
        type=str,
        help="Full Polymarket profile URL",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="./output/trader_activity.md",
        help="Output path for report",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Run with sample test data",
    )

    args = parser.parse_args()

    if args.test:
        # Sample test data
        sample_activity = [
            {
                "type": "Buy",
                "market": "Will Google release Gemini 2.0 by December 2025?",
                "amount": "$500.00",
                "timestamp": "2 hours ago",
            },
            {
                "type": "Sell",
                "market": "Will Google release Gemini 2.0 by December 2025?",
                "amount": "$250.00",
                "timestamp": "5 hours ago",
            },
            {
                "type": "Buy",
                "market": "Will Bitcoin reach $100k by end of 2024?",
                "amount": "$1,000.00",
                "timestamp": "8 hours ago",
            },
            {
                "type": "Reward",  # Should be excluded
                "market": "Daily reward",
                "amount": "$5.00",
                "timestamp": "1 hour ago",
            },
            {
                "type": "Buy",
                "market": "Will YouTube surpass 3B monthly users?",
                "amount": "$300.00",
                "timestamp": "12 hours ago",
            },
            {
                "type": "Redeem",
                "market": "Did Trump win 2024 election?",
                "amount": "$2,500.00",
                "timestamp": "20 hours ago",
            },
            {
                "type": "Buy",
                "market": "Old trade from last week",
                "amount": "$100.00",
                "timestamp": "3 days ago",  # Should be excluded
            },
        ]

        report = monitor_trader(
            trader_identifier="0xafEe",
            activity_data=sample_activity,
            output_path=args.output,
        )
        print(report)
        return

    trader = args.url or args.wallet
    if not trader:
        parser.error("Either --wallet or --url is required")

    report = monitor_trader(
        trader_identifier=trader,
        output_path=args.output,
    )
    print(report)


if __name__ == "__main__":
    main()
