#!/usr/bin/env python3
"""
Polymarket Real-Time Longshot Monitor

Continuously monitors the Polymarket trades API for suspicious longshot bets
and alerts when potential insider activity is detected.

Usage:
    python scripts/realtime_monitor.py
    python scripts/realtime_monitor.py --interval 30 --max-entry 0.15
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import requests

# API Base URL
DATA_API = "https://data-api.polymarket.com"

# ANSI color codes for terminal output
class Colors:
    RED = '\033[91m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    MAGENTA = '\033[95m'
    CYAN = '\033[96m'
    WHITE = '\033[97m'
    BOLD = '\033[1m'
    RESET = '\033[0m'


def clear_screen():
    """Clear terminal screen."""
    os.system('clear' if os.name != 'nt' else 'cls')


def fetch_recent_trades(limit: int = 100, min_value: float = 1000) -> List[Dict[str, Any]]:
    """Fetch recent trades from the Data API."""
    params = {
        "limit": limit,
        "filterType": "CASH",
        "filterAmount": min_value,
        "takerOnly": "true",
    }

    try:
        response = requests.get(f"{DATA_API}/trades", params=params, timeout=10)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"{Colors.RED}Error fetching trades: {e}{Colors.RESET}")
        return []


def fetch_trader_stats(wallet: str) -> Dict[str, Any]:
    """Fetch closed positions to calculate trader stats."""
    try:
        response = requests.get(
            f"{DATA_API}/closed-positions",
            params={"user": wallet, "limit": 50, "sortBy": "REALIZEDPNL", "sortDirection": "DESC"},
            timeout=10
        )
        response.raise_for_status()
        positions = response.json()

        longshot_wins = 0
        longshot_losses = 0
        total_profit = 0

        for pos in positions:
            avg_price = float(pos.get("avgPrice", 1))
            cur_price = float(pos.get("curPrice", 0))
            realized_pnl = float(pos.get("realizedPnl", 0))

            if avg_price < 0.25:  # Longshot
                if cur_price >= 0.99:
                    longshot_wins += 1
                    total_profit += realized_pnl
                elif cur_price <= 0.01:
                    longshot_losses += 1

        return {
            "longshot_wins": longshot_wins,
            "longshot_losses": longshot_losses,
            "total_profit": total_profit,
            "win_rate": longshot_wins / (longshot_wins + longshot_losses) if (longshot_wins + longshot_losses) > 0 else 0
        }
    except Exception:
        return {"longshot_wins": 0, "longshot_losses": 0, "total_profit": 0, "win_rate": 0}


def format_money(value: float) -> str:
    """Format number as money string."""
    if abs(value) >= 1_000_000:
        return f"${value / 1_000_000:.2f}M"
    elif abs(value) >= 1_000:
        return f"${value / 1_000:.1f}K"
    else:
        return f"${value:,.0f}"


def print_header():
    """Print monitor header."""
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*80}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.WHITE}  POLYMARKET REAL-TIME LONGSHOT MONITOR{Colors.RESET}")
    print(f"{Colors.CYAN}{'='*80}{Colors.RESET}")
    print(f"  {Colors.YELLOW}Watching for suspicious longshot trades...{Colors.RESET}")
    print(f"  Press Ctrl+C to stop\n")


def print_alert(trade: Dict[str, Any], stats: Dict[str, Any], is_new: bool = True):
    """Print a formatted alert for a suspicious trade."""
    wallet = trade.get("proxyWallet", "")[:12]
    name = trade.get("name", "") or trade.get("pseudonym", "Anonymous")
    title = trade.get("title", "Unknown")[:55]
    outcome = trade.get("outcome", "")
    price = float(trade.get("price", 0))
    size = float(trade.get("size", 0))
    value = price * size
    potential = size  # If wins, each share = $1
    ts = trade.get("timestamp", 0)
    trade_time = datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "N/A"

    # Calculate potential return
    potential_return = ((1 - price) / price) * 100 if price > 0 else 0

    # Determine alert level
    if stats["win_rate"] > 0.7 and stats["longshot_wins"] >= 3:
        alert_color = Colors.RED
        alert_level = "HIGH RISK"
    elif stats["win_rate"] > 0.5 or stats["total_profit"] > 50000:
        alert_color = Colors.YELLOW
        alert_level = "SUSPICIOUS"
    else:
        alert_color = Colors.CYAN
        alert_level = "LONGSHOT"

    new_tag = f"{Colors.GREEN}[NEW]{Colors.RESET} " if is_new else ""

    print(f"\n{new_tag}{alert_color}{Colors.BOLD}[{alert_level}]{Colors.RESET} {trade_time}")
    print(f"  {Colors.WHITE}{title}{Colors.RESET}")
    print(f"  {Colors.BOLD}{outcome}{Colors.RESET} @ {Colors.YELLOW}{price*100:.1f}%{Colors.RESET} odds")
    print(f"  Bet: {format_money(value)} | Potential Win: {Colors.GREEN}{format_money(potential)}{Colors.RESET} (+{potential_return:.0f}%)")
    print(f"  Trader: {name} ({wallet}...)")

    if stats["longshot_wins"] > 0 or stats["total_profit"] > 0:
        print(f"  {Colors.MAGENTA}History: {stats['longshot_wins']}W/{stats['longshot_losses']}L longshots | {format_money(stats['total_profit'])} profit{Colors.RESET}")

    print(f"  {Colors.BLUE}https://polymarket.com/profile/{trade.get('proxyWallet', '')}{Colors.RESET}")


def run_monitor(
    interval: int = 30,
    max_entry_price: float = 0.20,
    min_trade_value: float = 1000,
    alert_threshold: float = 5000,
):
    """
    Run the real-time monitor.

    Args:
        interval: Seconds between API checks
        max_entry_price: Maximum price to consider a longshot (default 20%)
        min_trade_value: Minimum trade value to fetch
        alert_threshold: Minimum value to show alert
    """
    seen_trades: Set[str] = set()
    trader_cache: Dict[str, Dict[str, Any]] = {}
    alerts_shown = 0

    clear_screen()
    print_header()

    print(f"  {Colors.WHITE}Settings:{Colors.RESET}")
    print(f"    Max entry price: {max_entry_price*100:.0f}%")
    print(f"    Min trade value: {format_money(min_trade_value)}")
    print(f"    Alert threshold: {format_money(alert_threshold)}")
    print(f"    Check interval: {interval}s")
    print()

    try:
        while True:
            trades = fetch_recent_trades(limit=100, min_value=min_trade_value)

            new_longshots = []
            for trade in trades:
                # Create unique trade ID
                trade_id = f"{trade.get('proxyWallet', '')}_{trade.get('timestamp', '')}_{trade.get('conditionId', '')}"

                if trade_id in seen_trades:
                    continue

                seen_trades.add(trade_id)

                # Check if it's a longshot BUY
                price = float(trade.get("price", 1))
                side = trade.get("side", "")
                value = price * float(trade.get("size", 0))

                if side == "BUY" and price < max_entry_price and value >= alert_threshold:
                    new_longshots.append(trade)

            # Process new longshots
            for trade in new_longshots:
                wallet = trade.get("proxyWallet", "")

                # Get or fetch trader stats (with caching)
                if wallet not in trader_cache:
                    trader_cache[wallet] = fetch_trader_stats(wallet)
                    time.sleep(0.3)  # Rate limit

                stats = trader_cache[wallet]
                print_alert(trade, stats, is_new=True)
                alerts_shown += 1

            # Status update
            now = datetime.now().strftime("%H:%M:%S")
            status = f"\r  {Colors.WHITE}[{now}]{Colors.RESET} Monitoring... {len(seen_trades)} trades seen, {alerts_shown} alerts | Next check in {interval}s"
            sys.stdout.write(status + " " * 10)
            sys.stdout.flush()

            # Wait for next interval
            time.sleep(interval)

    except KeyboardInterrupt:
        print(f"\n\n{Colors.YELLOW}Monitor stopped.{Colors.RESET}")
        print(f"  Total trades seen: {len(seen_trades)}")
        print(f"  Alerts shown: {alerts_shown}")

        # Save seen traders for future reference
        if trader_cache:
            output_path = Path("output/scans/monitored_traders.json")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w") as f:
                json.dump({
                    "last_run": datetime.now(timezone.utc).isoformat(),
                    "traders": trader_cache
                }, f, indent=2)
            print(f"  Trader data saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Real-time monitor for Polymarket longshot trades"
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=30,
        help="Seconds between API checks (default: 30)",
    )
    parser.add_argument(
        "--max-entry",
        type=float,
        default=0.20,
        help="Maximum entry price for longshots (default: 0.20 = 20%%)",
    )
    parser.add_argument(
        "--min-trade",
        type=float,
        default=1000,
        help="Minimum trade value to fetch (default: 1000)",
    )
    parser.add_argument(
        "--alert-threshold",
        type=float,
        default=5000,
        help="Minimum value to show alert (default: 5000)",
    )

    args = parser.parse_args()

    run_monitor(
        interval=args.interval,
        max_entry_price=args.max_entry,
        min_trade_value=args.min_trade,
        alert_threshold=args.alert_threshold,
    )


if __name__ == "__main__":
    main()
