#!/usr/bin/env python3
"""
Polymarket Daily Scanner

Run this script daily to:
1. Scan the leaderboard for top traders
2. Monitor watched traders (like the Google insider)
3. Detect new insider-like patterns
4. Generate alerts for copy-trading opportunities

Usage:
    python run_daily_scan.py
    python run_daily_scan.py --trader 0xafEe
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

# Watched traders - add addresses here to monitor
WATCHED_TRADERS = [
    {
        "address": "0xafEe",
        "name": "Google Insider",
        "categories": ["google"],
        "notes": "Known for Google search ranking bets with 100% accuracy"
    },
]


def load_config():
    """Load configuration."""
    config_path = Path(__file__).parent / "config.json"
    if config_path.exists():
        with open(config_path) as f:
            return json.load(f)
    return {}


def print_banner():
    """Print startup banner."""
    now = datetime.now(timezone.utc)
    print("\n" + "=" * 60)
    print("  POLYMARKET INSIDER TRACKER")
    print("  Daily Scan")
    print("=" * 60)
    print(f"  Date: {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print("=" * 60 + "\n")


def run_daily_scan(trader_address: str = None):
    """
    Run the daily scan.

    This is a template - you need to call Firecrawl to scrape the actual data.
    The scraping can be done via:
    1. This script with httpx (but Polymarket needs JS rendering)
    2. Firecrawl MCP tool (recommended)
    3. Manual export from browser
    """
    print_banner()

    if trader_address:
        print(f"Scanning specific trader: {trader_address}")
        traders_to_scan = [{"address": trader_address, "name": "Custom", "categories": []}]
    else:
        print(f"Scanning {len(WATCHED_TRADERS)} watched traders...")
        traders_to_scan = WATCHED_TRADERS

    print("\nTo scan a trader, use Firecrawl to scrape:")
    for trader in traders_to_scan:
        url = f"https://polymarket.com/@{trader['address']}?tab=activity"
        print(f"\n  Trader: {trader['name']} ({trader['address']})")
        print(f"  URL: {url}")

    print("\n" + "-" * 60)
    print("INTEGRATION OPTIONS:")
    print("-" * 60)
    print("""
1. FIRECRAWL MCP (Recommended):
   Use the firecrawl_scrape tool in Claude Code to scrape trader pages.

2. MANUAL WORKFLOW:
   a. Visit the trader's activity page in your browser
   b. Save the page as JSON/HTML
   c. Run: python scraping/insider_tracker.py --input-file <saved_file>

3. SCHEDULED AUTOMATION:
   Set up a cron job or GitHub Action to run this daily:

   # Example crontab entry (runs at 9 AM UTC daily)
   0 9 * * * cd /path/to/polymarket_alpha && python run_daily_scan.py

4. MANUS AUTOMATION:
   Use Manus's scheduled task feature with the prompt:
   "Visit https://polymarket.com/@0xafEe?tab=activity and extract all trades"
""")

    print("\n" + "=" * 60)
    print("  CURRENT WATCHED TRADERS")
    print("=" * 60)

    for trader in WATCHED_TRADERS:
        print(f"\n  {trader['name']}")
        print(f"  Address: {trader['address']}")
        print(f"  Focus: {', '.join(trader['categories'])}")
        print(f"  Notes: {trader['notes']}")

    print("\n")


def main():
    parser = argparse.ArgumentParser(description="Polymarket Daily Scanner")
    parser.add_argument("--trader", type=str, help="Specific trader to scan")
    parser.add_argument("--add-trader", type=str, help="Add a trader to watch list")

    args = parser.parse_args()

    if args.add_trader:
        print(f"To add a trader, edit WATCHED_TRADERS in {__file__}")
        print(f"Add: {args.add_trader}")
    else:
        run_daily_scan(args.trader)


if __name__ == "__main__":
    main()
