#!/usr/bin/env python3
"""
Polymarket Longshot Scanner

Scans the Polymarket Data API to find suspicious longshot wins that may indicate
insider trading. Uses the /trades endpoint to find wallets making profitable
longshot bets (entry price < 20%), then analyzes their closed positions.

Usage:
    python scripts/longshot_scanner.py
    python scripts/longshot_scanner.py --min-profit 10000 --max-entry 0.15
"""

import argparse
import json
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import requests

# API Base URL
DATA_API = "https://data-api.polymarket.com"

# Rate limiting
REQUEST_DELAY = 0.5  # seconds between requests


def fetch_trades(
    limit: int = 1000,
    offset: int = 0,
    filter_type: str = "CASH",
    filter_amount: float = 5000,
    side: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Fetch trades from the Data API."""
    params = {
        "limit": min(limit, 10000),
        "offset": offset,
        "filterType": filter_type,
        "filterAmount": filter_amount,
        "takerOnly": "true",
    }
    if side:
        params["side"] = side

    response = requests.get(f"{DATA_API}/trades", params=params)
    response.raise_for_status()
    return response.json()


def fetch_closed_positions(
    user: str,
    limit: int = 50,
    offset: int = 0,
    sort_by: str = "REALIZEDPNL",
    sort_direction: str = "DESC",
) -> List[Dict[str, Any]]:
    """Fetch closed positions for a specific user."""
    params = {
        "user": user,
        "limit": limit,
        "offset": offset,
        "sortBy": sort_by,
        "sortDirection": sort_direction,
    }

    response = requests.get(f"{DATA_API}/closed-positions", params=params)
    response.raise_for_status()
    return response.json()


def find_longshot_traders(
    max_entry_price: float = 0.20,
    min_trade_value: float = 5000,
    pages: int = 10,
) -> Dict[str, Dict[str, Any]]:
    """
    Find traders making large longshot bets.

    Args:
        max_entry_price: Maximum entry price to consider a longshot (default 20%)
        min_trade_value: Minimum trade value in USD
        pages: Number of pages to scan (100 trades per page)

    Returns:
        Dictionary mapping wallet addresses to their longshot trades
    """
    traders = defaultdict(lambda: {"trades": [], "total_longshot_value": 0})

    print(f"Scanning for longshot BUY trades (entry < {max_entry_price*100:.0f}%)...")
    print(f"Minimum trade value: ${min_trade_value:,.0f}")
    print()

    for page in range(pages):
        offset = page * 100
        print(f"  Fetching page {page + 1}/{pages} (offset {offset})...", end=" ")

        try:
            trades = fetch_trades(
                limit=100,
                offset=offset,
                filter_type="CASH",
                filter_amount=min_trade_value,
                side="BUY",
            )

            longshot_count = 0
            for trade in trades:
                price = float(trade.get("price", 1))
                if price < max_entry_price:
                    wallet = trade.get("proxyWallet", "")
                    size = float(trade.get("size", 0))
                    value = price * size

                    traders[wallet]["trades"].append(trade)
                    traders[wallet]["total_longshot_value"] += value
                    longshot_count += 1

            print(f"Found {longshot_count} longshot trades")
            time.sleep(REQUEST_DELAY)

        except Exception as e:
            print(f"Error: {e}")
            continue

    return dict(traders)


def analyze_trader_positions(
    wallet: str,
    max_entry_price: float = 0.20,
) -> Dict[str, Any]:
    """
    Analyze a trader's closed positions for suspicious longshot wins.

    Returns analysis with:
    - Total longshot wins (entry < max_entry_price, curPrice = 1)
    - Total profit from longshots
    - Win rate on longshots
    - Suspicion score
    """
    try:
        positions = fetch_closed_positions(wallet, limit=50)
    except Exception as e:
        return {"error": str(e)}

    analysis = {
        "wallet": wallet,
        "longshot_wins": [],
        "longshot_losses": [],
        "total_longshot_profit": 0,
        "total_longshot_loss": 0,
        "longshot_win_count": 0,
        "longshot_loss_count": 0,
        "regular_positions": 0,
    }

    for pos in positions:
        avg_price = float(pos.get("avgPrice", 1))
        cur_price = float(pos.get("curPrice", 0))
        realized_pnl = float(pos.get("realizedPnl", 0))
        total_bought = float(pos.get("totalBought", 0))

        # Check if this was a longshot bet
        if avg_price < max_entry_price:
            if cur_price >= 0.99:  # Won (price = 1)
                analysis["longshot_wins"].append({
                    "title": pos.get("title", "Unknown"),
                    "outcome": pos.get("outcome", ""),
                    "entry_price": avg_price,
                    "shares": total_bought,
                    "profit": realized_pnl,
                    "return_pct": (realized_pnl / (avg_price * total_bought) * 100) if avg_price * total_bought > 0 else 0,
                })
                analysis["total_longshot_profit"] += realized_pnl
                analysis["longshot_win_count"] += 1
            elif cur_price <= 0.01:  # Lost (price = 0)
                analysis["longshot_losses"].append({
                    "title": pos.get("title", "Unknown"),
                    "outcome": pos.get("outcome", ""),
                    "entry_price": avg_price,
                    "shares": total_bought,
                    "loss": realized_pnl,
                })
                analysis["total_longshot_loss"] += realized_pnl
                analysis["longshot_loss_count"] += 1
        else:
            analysis["regular_positions"] += 1

    # Calculate suspicion score
    total_longshots = analysis["longshot_win_count"] + analysis["longshot_loss_count"]
    if total_longshots > 0:
        win_rate = analysis["longshot_win_count"] / total_longshots
        # Suspicion factors:
        # 1. High win rate on longshots (>50% on <20% odds bets is suspicious)
        # 2. Large total profit
        # 3. Multiple longshot wins

        suspicion_score = 0

        # Win rate factor (max 40 points)
        if win_rate > 0.8:
            suspicion_score += 40
        elif win_rate > 0.6:
            suspicion_score += 30
        elif win_rate > 0.4:
            suspicion_score += 20
        elif win_rate > 0.2:
            suspicion_score += 10

        # Profit factor (max 30 points)
        if analysis["total_longshot_profit"] > 100000:
            suspicion_score += 30
        elif analysis["total_longshot_profit"] > 50000:
            suspicion_score += 20
        elif analysis["total_longshot_profit"] > 10000:
            suspicion_score += 10

        # Multiple wins factor (max 30 points)
        if analysis["longshot_win_count"] >= 5:
            suspicion_score += 30
        elif analysis["longshot_win_count"] >= 3:
            suspicion_score += 20
        elif analysis["longshot_win_count"] >= 2:
            suspicion_score += 10

        analysis["suspicion_score"] = suspicion_score
        analysis["win_rate"] = win_rate
    else:
        analysis["suspicion_score"] = 0
        analysis["win_rate"] = 0

    return analysis


def scan_for_insiders(
    max_entry_price: float = 0.20,
    min_trade_value: float = 5000,
    min_suspicion_score: int = 50,
    pages: int = 10,
    output_file: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Main scanner function to find potential insider traders.

    Args:
        max_entry_price: Maximum entry price for longshots (default 20%)
        min_trade_value: Minimum trade value in USD
        min_suspicion_score: Minimum suspicion score to report
        pages: Number of trade pages to scan
        output_file: Optional file to save results

    Returns:
        List of suspicious traders with their analysis
    """
    print("=" * 80)
    print("POLYMARKET LONGSHOT INSIDER SCANNER")
    print("=" * 80)
    print()
    print(f"Parameters:")
    print(f"  Max entry price: {max_entry_price*100:.0f}%")
    print(f"  Min trade value: ${min_trade_value:,.0f}")
    print(f"  Min suspicion score: {min_suspicion_score}")
    print(f"  Pages to scan: {pages}")
    print()

    # Step 1: Find traders making longshot bets
    traders = find_longshot_traders(
        max_entry_price=max_entry_price,
        min_trade_value=min_trade_value,
        pages=pages,
    )

    print()
    print(f"Found {len(traders)} unique wallets making longshot bets")
    print()

    if not traders:
        print("No longshot traders found. Try adjusting parameters.")
        return []

    # Step 2: Analyze each trader's closed positions
    print("Analyzing trader positions...")
    print()

    suspicious_traders = []

    for i, (wallet, data) in enumerate(traders.items()):
        print(f"  Analyzing wallet {i+1}/{len(traders)}: {wallet[:10]}...", end=" ")

        analysis = analyze_trader_positions(wallet, max_entry_price)
        time.sleep(REQUEST_DELAY)

        if "error" in analysis:
            print(f"Error: {analysis['error']}")
            continue

        score = analysis.get("suspicion_score", 0)
        print(f"Score: {score}")

        if score >= min_suspicion_score:
            analysis["recent_trades"] = data["trades"][:5]  # Keep top 5 trades
            suspicious_traders.append(analysis)

    # Sort by suspicion score
    suspicious_traders.sort(key=lambda x: x.get("suspicion_score", 0), reverse=True)

    # Print results
    print()
    print("=" * 80)
    print(f"SUSPICIOUS TRADERS (Score >= {min_suspicion_score})")
    print("=" * 80)
    print()

    if not suspicious_traders:
        print("No suspicious traders found above the threshold.")
    else:
        for i, trader in enumerate(suspicious_traders[:20]):  # Top 20
            print(f"#{i+1} - {trader['wallet']}")
            print(f"    Suspicion Score: {trader['suspicion_score']}/100")
            print(f"    Longshot Win Rate: {trader['win_rate']*100:.1f}%")
            print(f"    Longshot Wins: {trader['longshot_win_count']} | Losses: {trader['longshot_loss_count']}")
            print(f"    Total Longshot Profit: ${trader['total_longshot_profit']:,.0f}")
            print()

            if trader["longshot_wins"]:
                print("    Top Longshot Wins:")
                for win in trader["longshot_wins"][:3]:
                    title = win["title"][:50] if len(win["title"]) > 50 else win["title"]
                    print(f"      - {title}")
                    print(f"        {win['outcome']} @ {win['entry_price']*100:.1f}% -> +${win['profit']:,.0f} ({win['return_pct']:.0f}%)")
            print()
            print("-" * 40)
            print()

    # Save results
    if output_file:
        output_path = Path(output_file)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        report = {
            "scan_time": datetime.now(timezone.utc).isoformat(),
            "parameters": {
                "max_entry_price": max_entry_price,
                "min_trade_value": min_trade_value,
                "min_suspicion_score": min_suspicion_score,
                "pages_scanned": pages,
            },
            "traders_scanned": len(traders),
            "suspicious_traders": suspicious_traders,
        }

        with open(output_path, "w") as f:
            json.dump(report, f, indent=2)

        print(f"Results saved to: {output_path}")

    return suspicious_traders


def main():
    parser = argparse.ArgumentParser(
        description="Scan Polymarket for suspicious longshot wins"
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
        default=5000,
        help="Minimum trade value in USD (default: 5000)",
    )
    parser.add_argument(
        "--min-score",
        type=int,
        default=50,
        help="Minimum suspicion score to report (default: 50)",
    )
    parser.add_argument(
        "--pages",
        type=int,
        default=10,
        help="Number of trade pages to scan (default: 10, 100 trades/page)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output file for JSON results",
    )

    args = parser.parse_args()

    # Set default output file
    if args.output is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        args.output = f"output/scans/longshot_scan_{timestamp}.json"

    scan_for_insiders(
        max_entry_price=args.max_entry,
        min_trade_value=args.min_trade,
        min_suspicion_score=args.min_score,
        pages=args.pages,
        output_file=args.output,
    )


if __name__ == "__main__":
    main()
