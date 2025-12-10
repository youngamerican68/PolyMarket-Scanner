#!/usr/bin/env python3
"""
Daily Longshot Report Generator

Generates a daily report of all longshot trades placed in the last 24 hours,
aggregated by trader with suspicion scoring.

Usage:
    python scripts/daily_longshot_report.py
    python scripts/daily_longshot_report.py --output markdown
    python scripts/daily_longshot_report.py --output json

Can be run as a daily cron job.
"""

import argparse
import json
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List

import requests

DATA_API = "https://data-api.polymarket.com"
REQUEST_DELAY = 0.3


def fetch_all_trades(hours: int = 24, min_value: float = 500) -> List[Dict[str, Any]]:
    """Fetch all trades from the last N hours."""
    all_trades = []
    cutoff_time = datetime.now(timezone.utc) - timedelta(hours=hours)
    cutoff_ts = int(cutoff_time.timestamp())

    print(f"Fetching trades from last {hours} hours (since {cutoff_time.strftime('%Y-%m-%d %H:%M UTC')})...")

    offset = 0
    page = 0
    while True:
        page += 1
        print(f"  Page {page} (offset {offset})...", end=" ")

        try:
            resp = requests.get(f"{DATA_API}/trades", params={
                "limit": 500,
                "offset": offset,
                "filterType": "CASH",
                "filterAmount": min_value,
                "takerOnly": "true",
            }, timeout=30)
            resp.raise_for_status()
            trades = resp.json()

            if not trades:
                print("No more trades")
                break

            # Filter by time
            new_trades = [t for t in trades if t.get("timestamp", 0) >= cutoff_ts]
            all_trades.extend(new_trades)

            print(f"Got {len(new_trades)} trades in range")

            # If we got trades older than cutoff, we're done
            oldest_ts = min(t.get("timestamp", 0) for t in trades)
            if oldest_ts < cutoff_ts:
                print("  Reached cutoff time")
                break

            offset += 500
            time.sleep(REQUEST_DELAY)

            # Safety limit
            if offset > 10000:
                print("  Reached API limit")
                break

        except Exception as e:
            print(f"Error: {e}")
            break

    return all_trades


def fetch_trader_history(wallet: str) -> Dict[str, Any]:
    """Fetch closed positions to get trader's historical performance."""
    try:
        resp = requests.get(f"{DATA_API}/closed-positions", params={
            "user": wallet,
            "limit": 50,
            "sortBy": "REALIZEDPNL",
            "sortDirection": "DESC",
        }, timeout=15)
        resp.raise_for_status()
        positions = resp.json()

        longshot_wins = 0
        longshot_losses = 0
        total_profit = 0
        top_wins = []

        for pos in positions:
            avg_price = float(pos.get("avgPrice", 1))
            cur_price = float(pos.get("curPrice", 0))
            pnl = float(pos.get("realizedPnl", 0))

            if avg_price < 0.25:
                if cur_price >= 0.99:
                    longshot_wins += 1
                    total_profit += pnl
                    top_wins.append({
                        "title": pos.get("title", ""),
                        "outcome": pos.get("outcome", ""),
                        "entry": avg_price,
                        "profit": pnl,
                    })
                elif cur_price <= 0.01:
                    longshot_losses += 1

        total = longshot_wins + longshot_losses
        return {
            "longshot_wins": longshot_wins,
            "longshot_losses": longshot_losses,
            "total_profit": total_profit,
            "win_rate": longshot_wins / total if total > 0 else 0,
            "top_wins": sorted(top_wins, key=lambda x: x["profit"], reverse=True)[:3],
        }
    except Exception as e:
        return {"longshot_wins": 0, "longshot_losses": 0, "total_profit": 0, "win_rate": 0, "top_wins": [], "error": str(e)}


def calculate_suspicion_score(history: Dict[str, Any], daily_volume: float, num_trades: int) -> int:
    """Calculate suspicion score based on history and daily activity."""
    score = 0

    # Historical win rate (max 40)
    if history["win_rate"] > 0.8:
        score += 40
    elif history["win_rate"] > 0.6:
        score += 30
    elif history["win_rate"] > 0.4:
        score += 20
    elif history["win_rate"] > 0.2:
        score += 10

    # Historical profit (max 30)
    if history["total_profit"] > 100000:
        score += 30
    elif history["total_profit"] > 50000:
        score += 20
    elif history["total_profit"] > 10000:
        score += 10

    # Daily volume (max 20)
    if daily_volume > 50000:
        score += 20
    elif daily_volume > 20000:
        score += 15
    elif daily_volume > 10000:
        score += 10
    elif daily_volume > 5000:
        score += 5

    # Multiple wins (max 10)
    if history["longshot_wins"] >= 5:
        score += 10
    elif history["longshot_wins"] >= 3:
        score += 7
    elif history["longshot_wins"] >= 2:
        score += 5

    return score


def format_money(value: float) -> str:
    if abs(value) >= 1_000_000:
        return f"${value/1_000_000:.2f}M"
    elif abs(value) >= 1_000:
        return f"${value/1_000:.1f}K"
    return f"${value:,.0f}"


def generate_report(hours: int = 24, min_value: float = 500, max_entry: float = 0.25) -> Dict[str, Any]:
    """Generate the daily longshot report."""

    # Fetch trades
    trades = fetch_all_trades(hours=hours, min_value=min_value)

    # Filter longshot BUYs
    longshot_trades = [
        t for t in trades
        if t.get("side") == "BUY" and float(t.get("price", 1)) < max_entry
    ]

    print(f"\nFound {len(longshot_trades)} longshot trades out of {len(trades)} total")

    # Group by wallet
    by_wallet: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
        "trades": [],
        "total_value": 0,
        "total_potential": 0,
        "markets": set(),
    })

    for trade in longshot_trades:
        wallet = trade.get("proxyWallet", "")
        price = float(trade.get("price", 0))
        size = float(trade.get("size", 0))
        value = price * size

        by_wallet[wallet]["trades"].append(trade)
        by_wallet[wallet]["total_value"] += value
        by_wallet[wallet]["total_potential"] += size
        by_wallet[wallet]["markets"].add(trade.get("title", ""))
        by_wallet[wallet]["name"] = trade.get("name", "") or trade.get("pseudonym", "Anonymous")

    # Analyze top wallets by volume
    wallets_by_volume = sorted(by_wallet.items(), key=lambda x: x[1]["total_value"], reverse=True)

    print(f"\nAnalyzing top {min(20, len(wallets_by_volume))} wallets by volume...")

    analyzed_wallets = []
    for wallet, data in wallets_by_volume[:20]:
        print(f"  {wallet[:12]}... ({format_money(data['total_value'])})", end=" ")

        history = fetch_trader_history(wallet)
        time.sleep(REQUEST_DELAY)

        score = calculate_suspicion_score(history, data["total_value"], len(data["trades"]))
        print(f"Score: {score}")

        analyzed_wallets.append({
            "wallet": wallet,
            "name": data["name"],
            "daily_trades": len(data["trades"]),
            "daily_value": data["total_value"],
            "daily_potential": data["total_potential"],
            "markets_count": len(data["markets"]),
            "markets": list(data["markets"])[:5],
            "trades": data["trades"][:10],
            "history": history,
            "suspicion_score": score,
        })

    # Sort by suspicion score
    analyzed_wallets.sort(key=lambda x: x["suspicion_score"], reverse=True)

    # Build report
    report = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "period_hours": hours,
        "summary": {
            "total_trades": len(trades),
            "longshot_trades": len(longshot_trades),
            "unique_wallets": len(by_wallet),
            "total_longshot_volume": sum(d["total_value"] for d in by_wallet.values()),
            "total_potential_payout": sum(d["total_potential"] for d in by_wallet.values()),
        },
        "suspicious_traders": [w for w in analyzed_wallets if w["suspicion_score"] >= 40],
        "all_longshot_traders": analyzed_wallets,
        "top_trades": sorted(longshot_trades, key=lambda x: float(x.get("price", 1)) * float(x.get("size", 0)), reverse=True)[:20],
    }

    return report


def format_markdown_report(report: Dict[str, Any]) -> str:
    """Format report as markdown."""
    lines = []

    # Header
    gen_time = datetime.fromisoformat(report["generated"].replace("Z", "+00:00"))
    lines.append(f"# Daily Longshot Report")
    lines.append(f"**Generated:** {gen_time.strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append(f"**Period:** Last {report['period_hours']} hours")
    lines.append("")

    # Summary
    s = report["summary"]
    lines.append("## Summary")
    lines.append(f"- **Total Trades Analyzed:** {s['total_trades']:,}")
    lines.append(f"- **Longshot Trades (<25% odds):** {s['longshot_trades']:,}")
    lines.append(f"- **Unique Wallets:** {s['unique_wallets']}")
    lines.append(f"- **Total Longshot Volume:** {format_money(s['total_longshot_volume'])}")
    lines.append(f"- **Total Potential Payout:** {format_money(s['total_potential_payout'])}")
    lines.append("")

    # Suspicious traders
    suspicious = report["suspicious_traders"]
    if suspicious:
        lines.append("## Suspicious Traders (Score >= 40)")
        lines.append("")

        for i, trader in enumerate(suspicious[:10], 1):
            h = trader["history"]
            lines.append(f"### #{i} - {trader['name']} (Score: {trader['suspicion_score']}/100)")
            lines.append(f"**Wallet:** `{trader['wallet']}`")
            lines.append("")
            lines.append("| Metric | Value |")
            lines.append("|--------|-------|")
            lines.append(f"| Today's Trades | {trader['daily_trades']} |")
            lines.append(f"| Today's Volume | {format_money(trader['daily_value'])} |")
            lines.append(f"| Potential Payout | {format_money(trader['daily_potential'])} |")
            lines.append(f"| Historical Win Rate | {h['win_rate']*100:.0f}% |")
            lines.append(f"| Historical W/L | {h['longshot_wins']}/{h['longshot_losses']} |")
            lines.append(f"| Total Profit | {format_money(h['total_profit'])} |")
            lines.append("")

            if h.get("top_wins"):
                lines.append("**Top Historical Wins:**")
                for win in h["top_wins"][:3]:
                    lines.append(f"- {win['outcome']} @ {win['entry']*100:.0f}% → +{format_money(win['profit'])} ({win['title'][:40]}...)")
                lines.append("")

            lines.append(f"**Today's Markets:** {', '.join(m[:30] for m in trader['markets'][:3])}")
            lines.append("")
            lines.append("---")
            lines.append("")
    else:
        lines.append("## Suspicious Traders")
        lines.append("*No highly suspicious activity detected today.*")
        lines.append("")

    # Top trades
    lines.append("## Largest Longshot Trades Today")
    lines.append("")
    lines.append("| Market | Outcome | Odds | Value | Potential | Trader |")
    lines.append("|--------|---------|------|-------|-----------|--------|")

    for trade in report["top_trades"][:15]:
        price = float(trade.get("price", 0))
        size = float(trade.get("size", 0))
        value = price * size
        name = trade.get("name", "") or trade.get("pseudonym", "Anon")
        title = trade.get("title", "")[:35]

        lines.append(f"| {title} | {trade.get('outcome', '')} | {price*100:.1f}% | {format_money(value)} | {format_money(size)} | {name[:15]} |")

    lines.append("")
    lines.append("---")
    lines.append("*Report generated by Polymarket Insider Tracker*")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate daily longshot report")
    parser.add_argument("--hours", type=int, default=24, help="Hours to look back (default: 24)")
    parser.add_argument("--min-value", type=float, default=500, help="Minimum trade value (default: 500)")
    parser.add_argument("--max-entry", type=float, default=0.25, help="Maximum entry price for longshots (default: 0.25)")
    parser.add_argument("--output", choices=["markdown", "json", "both"], default="both", help="Output format")

    args = parser.parse_args()

    print("=" * 60)
    print("DAILY LONGSHOT REPORT GENERATOR")
    print("=" * 60)
    print()

    report = generate_report(hours=args.hours, min_value=args.min_value, max_entry=args.max_entry)

    # Create output directory
    output_dir = Path("output/daily_reports")
    output_dir.mkdir(parents=True, exist_ok=True)

    date_str = datetime.now().strftime("%Y-%m-%d")

    if args.output in ["json", "both"]:
        json_path = output_dir / f"longshot_report_{date_str}.json"
        with open(json_path, "w") as f:
            json.dump(report, f, indent=2, default=str)
        print(f"\nJSON saved to: {json_path}")

    if args.output in ["markdown", "both"]:
        md_content = format_markdown_report(report)
        md_path = output_dir / f"longshot_report_{date_str}.md"
        with open(md_path, "w") as f:
            f.write(md_content)
        print(f"Markdown saved to: {md_path}")

        # Also print to console
        print("\n" + "=" * 60)
        print(md_content)


if __name__ == "__main__":
    main()
