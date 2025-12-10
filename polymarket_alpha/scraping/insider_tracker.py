#!/usr/bin/env python3
"""
Polymarket Insider Tracker

Complete system to:
1. Find top traders from leaderboard
2. Analyze their positions for insider patterns
3. Monitor specific traders (like Google insider 0xafEe)
4. Generate daily reports for copy-trading signals

Based on Dave Wang's automation concept.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.logging_config import get_logger

logger = get_logger(__name__)


# Categories to watch for insider patterns
INSIDER_CATEGORIES = {
    "google": {
        "keywords": [
            "google", "alphabet", "deepmind", "waymo", "gemini", "bard",
            "youtube", "android", "chrome", "pixel", "nest", "search",
            "searched", "year in search"
        ],
        "description": "Google/Alphabet products and search rankings"
    },
    "apple": {
        "keywords": [
            "apple", "iphone", "ipad", "mac", "ios", "wwdc", "tim cook",
            "vision pro", "airpods", "apple watch"
        ],
        "description": "Apple products and announcements"
    },
    "openai": {
        "keywords": [
            "openai", "chatgpt", "gpt-5", "gpt-4", "sam altman", "dall-e", "sora"
        ],
        "description": "OpenAI products and releases"
    },
    "tesla": {
        "keywords": [
            "tesla", "elon musk", "cybertruck", "model", "spacex", "starlink"
        ],
        "description": "Tesla/SpaceX/Elon Musk"
    },
    "meta": {
        "keywords": [
            "meta", "facebook", "instagram", "whatsapp", "zuckerberg", "llama", "threads"
        ],
        "description": "Meta/Facebook products"
    },
    "microsoft": {
        "keywords": [
            "microsoft", "bing", "copilot", "azure", "xbox", "satya nadella"
        ],
        "description": "Microsoft products"
    },
}


@dataclass
class Position:
    """A trader's position in a market."""
    market: str
    market_url: str
    outcome: str  # Yes/No
    shares: float
    avg_price: float
    current_price: float
    value: float
    profit_loss: float
    profit_pct: float
    categories: List[str] = field(default_factory=list)


@dataclass
class Trade:
    """A single trade/activity."""
    timestamp: str
    trade_type: str  # Buy, Sell, Redeem
    market: str
    market_url: str
    outcome: Optional[str]
    shares: float
    amount: float
    price: Optional[float]
    categories: List[str] = field(default_factory=list)


@dataclass
class TraderProfile:
    """Complete trader profile with analysis."""
    address: str
    username: str
    positions_value: float
    biggest_win: float
    predictions: int
    positions: List[Position]
    recent_trades: List[Trade]
    category_concentration: Dict[str, float]
    insider_signals: List[str]


def parse_money(text: str) -> float:
    """Parse money string like '$1.2M' or '$500.00' to float."""
    if not text:
        return 0.0

    text = str(text).strip().replace(",", "").replace("$", "")

    # Handle negative
    negative = text.startswith("-") or text.startswith("(")
    text = text.replace("-", "").replace("(", "").replace(")", "")

    multiplier = 1
    if text.endswith("K"):
        multiplier = 1_000
        text = text[:-1]
    elif text.endswith("M"):
        multiplier = 1_000_000
        text = text[:-1]
    elif text.endswith("B"):
        multiplier = 1_000_000_000
        text = text[:-1]

    try:
        value = float(text) * multiplier
        return -value if negative else value
    except ValueError:
        return 0.0


def categorize_market(market_text: str) -> List[str]:
    """Identify which categories a market belongs to."""
    if not market_text:
        return []

    market_lower = market_text.lower()
    categories = []

    for category, config in INSIDER_CATEGORIES.items():
        if any(kw in market_lower for kw in config["keywords"]):
            categories.append(category)

    return categories


def parse_positions_from_markdown(markdown: str) -> List[Position]:
    """Parse positions from scraped markdown."""
    positions = []

    # Pattern to match position blocks
    # Looking for market name, outcome, shares, prices, value
    lines = markdown.split("\n")

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Look for market links
        if line.startswith("[") and "polymarket.com/event" in line:
            # Extract market name and URL
            match = re.match(r'\[([^\]]+)\]\(([^)]+)\)', line)
            if match:
                market = match.group(1)
                market_url = match.group(2)

                # Look for position details in next lines
                outcome = None
                shares = 0.0
                avg_price = 0.0
                current_price = 0.0
                value = 0.0
                profit_loss = 0.0
                profit_pct = 0.0

                # Check next few lines for details
                for j in range(i+1, min(i+10, len(lines))):
                    detail_line = lines[j].strip()

                    # Outcome (Yes/No)
                    if detail_line in ["Yes", "No"]:
                        outcome = detail_line

                    # Shares info
                    if "shares at" in detail_line.lower():
                        share_match = re.search(r'([\d,]+\.?\d*)\s*shares\s*at\s*(\d+)¢', detail_line)
                        if share_match:
                            shares = float(share_match.group(1).replace(",", ""))
                            avg_price = float(share_match.group(2)) / 100

                    # Current price
                    if re.match(r'^\d+¢$', detail_line):
                        current_price = float(detail_line.replace("¢", "")) / 100

                    # Value and P/L
                    if detail_line.startswith("$") and "(" in detail_line:
                        # Format: $1,103,572.64$165,943.11 (17.7%)
                        val_match = re.search(r'\$([\d,]+\.?\d*)\$?([\d,]+\.?\d*)\s*\(([\d.-]+)%\)', detail_line)
                        if val_match:
                            value = parse_money(val_match.group(1))
                            profit_loss = parse_money(val_match.group(2))
                            profit_pct = float(val_match.group(3))

                if market and outcome:
                    categories = categorize_market(market)
                    positions.append(Position(
                        market=market,
                        market_url=market_url,
                        outcome=outcome,
                        shares=shares,
                        avg_price=avg_price,
                        current_price=current_price,
                        value=value,
                        profit_loss=profit_loss,
                        profit_pct=profit_pct,
                        categories=categories,
                    ))
        i += 1

    return positions


def parse_trades_from_markdown(markdown: str) -> List[Trade]:
    """Parse recent trades/activity from scraped markdown."""
    trades = []

    lines = markdown.split("\n")

    # Look for the Activity section patterns
    # Type | Market | Amount format

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Look for trade type indicators
        if line in ["Buy", "Sell", "Redeem"]:
            trade_type = line
            market = None
            market_url = None
            outcome = None
            shares = 0.0
            amount = 0.0
            price = None
            timestamp = None

            # Look at next lines for details
            for j in range(i+1, min(i+8, len(lines))):
                detail_line = lines[j].strip()

                # Market link
                if detail_line.startswith("[") and "polymarket.com/event" in detail_line:
                    match = re.match(r'\[([^\]]+)\]\(([^)]+)\)', detail_line)
                    if match:
                        market = match.group(1)
                        market_url = match.group(2)

                # Outcome and price (e.g., "No 54¢")
                if re.match(r'^(Yes|No)\s+\d+¢$', detail_line):
                    parts = detail_line.split()
                    outcome = parts[0]
                    price = float(parts[1].replace("¢", "")) / 100

                # Shares
                if "shares" in detail_line.lower():
                    share_match = re.search(r'([\d,]+\.?\d*)\s*shares', detail_line)
                    if share_match:
                        shares = float(share_match.group(1).replace(",", ""))

                # Amount
                if detail_line.startswith("$") and "(" not in detail_line:
                    amount = parse_money(detail_line)

                # Timestamp
                if "ago" in detail_line.lower() or "days ago" in detail_line.lower():
                    timestamp_match = re.search(r'\[([^\]]+)\]', detail_line)
                    if timestamp_match:
                        timestamp = timestamp_match.group(1)
                    else:
                        timestamp = detail_line

            if market and trade_type:
                categories = categorize_market(market)
                trades.append(Trade(
                    timestamp=timestamp or "Unknown",
                    trade_type=trade_type,
                    market=market,
                    market_url=market_url or "",
                    outcome=outcome,
                    shares=shares,
                    amount=amount,
                    price=price,
                    categories=categories,
                ))
        i += 1

    return trades


def calculate_category_concentration(
    positions: List[Position],
    trades: List[Trade]
) -> Dict[str, float]:
    """Calculate concentration by category."""
    category_value: Dict[str, float] = {}
    total_value = 0.0

    for pos in positions:
        total_value += pos.value
        for cat in pos.categories:
            category_value[cat] = category_value.get(cat, 0) + pos.value

    if total_value == 0:
        return {}

    return {cat: val / total_value for cat, val in category_value.items()}


def detect_insider_signals(
    positions: List[Position],
    trades: List[Trade],
    category_concentration: Dict[str, float]
) -> List[str]:
    """Detect potential insider trading signals."""
    signals = []

    # High category concentration (>50%)
    for cat, conc in category_concentration.items():
        if conc > 0.5:
            signals.append(
                f"HEAVY {cat.upper()} CONCENTRATION: {conc:.1%} of portfolio in {cat}-related markets"
            )

    # High win rate positions
    winning_positions = [p for p in positions if p.profit_pct > 50]
    if len(winning_positions) >= 3:
        signals.append(
            f"MULTIPLE BIG WINNERS: {len(winning_positions)} positions with >50% gains"
        )

    # Cluster buying (multiple trades in same market recently)
    market_trade_counts: Dict[str, int] = {}
    for trade in trades[:50]:  # Last 50 trades
        if trade.trade_type == "Buy":
            market_trade_counts[trade.market] = market_trade_counts.get(trade.market, 0) + 1

    cluster_markets = [m for m, c in market_trade_counts.items() if c >= 3]
    if cluster_markets:
        signals.append(
            f"CLUSTER BUYING: Multiple buy orders on {len(cluster_markets)} markets"
        )

    # Large position sizes
    large_positions = [p for p in positions if p.value > 100000]
    if large_positions:
        signals.append(
            f"LARGE POSITIONS: {len(large_positions)} positions over $100K"
        )

    # Perfect or near-perfect wins on resolved positions
    redemptions = [t for t in trades if t.trade_type == "Redeem"]
    if len(redemptions) >= 5:
        signals.append(
            f"HIGH REDEMPTION RATE: {len(redemptions)} successful redemptions recently"
        )

    return signals


def generate_report(profile: TraderProfile, output_format: str = "markdown") -> str:
    """Generate a report for copy-trading analysis."""

    now = datetime.now(timezone.utc)

    lines = [
        f"# Polymarket Insider Tracker Report",
        f"",
        f"**Generated:** {now.strftime('%Y-%m-%d %H:%M:%S UTC')}",
        f"**Trader:** [{profile.username}](https://polymarket.com/@{profile.address})",
        f"",
        f"## Summary",
        f"",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Portfolio Value | ${profile.positions_value:,.0f} |",
        f"| Biggest Win | ${profile.biggest_win:,.0f} |",
        f"| Total Predictions | {profile.predictions} |",
        f"| Active Positions | {len(profile.positions)} |",
        f"",
    ]

    # Insider signals
    if profile.insider_signals:
        lines.extend([
            f"## Insider Signals",
            f"",
        ])
        for signal in profile.insider_signals:
            lines.append(f"- {signal}")
        lines.append("")

    # Category concentration
    if profile.category_concentration:
        lines.extend([
            f"## Category Concentration",
            f"",
            f"| Category | % of Portfolio |",
            f"|----------|----------------|",
        ])
        for cat, pct in sorted(profile.category_concentration.items(), key=lambda x: -x[1]):
            lines.append(f"| {cat.title()} | {pct:.1%} |")
        lines.append("")

    # Top positions by value
    lines.extend([
        f"## Top Positions (by Value)",
        f"",
        f"| Market | Outcome | Value | P/L | Categories |",
        f"|--------|---------|-------|-----|------------|",
    ])

    sorted_positions = sorted(profile.positions, key=lambda x: -x.value)[:15]
    for pos in sorted_positions:
        market_short = pos.market[:50] + "..." if len(pos.market) > 50 else pos.market
        cats = ", ".join(pos.categories) if pos.categories else "-"
        pl_str = f"+{pos.profit_pct:.0f}%" if pos.profit_pct > 0 else f"{pos.profit_pct:.0f}%"
        lines.append(
            f"| {market_short} | {pos.outcome} | ${pos.value:,.0f} | {pl_str} | {cats} |"
        )
    lines.append("")

    # Recent trades
    recent_buys = [t for t in profile.recent_trades if t.trade_type == "Buy"][:10]
    if recent_buys:
        lines.extend([
            f"## Recent Buy Activity",
            f"",
            f"| Time | Market | Outcome | Amount | Categories |",
            f"|------|--------|---------|--------|------------|",
        ])
        for trade in recent_buys:
            market_short = trade.market[:40] + "..." if len(trade.market) > 40 else trade.market
            cats = ", ".join(trade.categories) if trade.categories else "-"
            lines.append(
                f"| {trade.timestamp} | {market_short} | {trade.outcome or '-'} | ${trade.amount:,.0f} | {cats} |"
            )
        lines.append("")

    # Copy-trading recommendation
    lines.extend([
        f"## Copy-Trading Analysis",
        f"",
    ])

    if profile.insider_signals:
        lines.append("**Potential insider activity detected.** Monitor this trader closely.")
        lines.append("")
        lines.append("**Current high-conviction positions:**")

        # Find positions with multiple buy signals
        for pos in sorted_positions[:5]:
            if pos.categories:
                lines.append(f"- **{pos.market}** ({pos.outcome}) - ${pos.value:,.0f}")
    else:
        lines.append("No strong insider signals detected at this time.")

    return "\n".join(lines)


def parse_trader_from_scraped_data(markdown: str) -> TraderProfile:
    """Parse complete trader profile from scraped markdown data."""

    # Extract basic info
    username = "Unknown"
    address = "Unknown"
    positions_value = 0.0
    biggest_win = 0.0
    predictions = 0

    # Try to extract username
    username_match = re.search(r'^([0-9a-zA-Z_-]+)\n\nJoined', markdown, re.MULTILINE)
    if username_match:
        username = username_match.group(1)

    # Extract stats
    stats_match = re.search(r'Positions Value\n\n\$([\d.]+[KMB]?)', markdown)
    if stats_match:
        positions_value = parse_money(stats_match.group(1))

    win_match = re.search(r'Biggest Win\n\n\$([\d.]+[KMB]?)', markdown)
    if win_match:
        biggest_win = parse_money(win_match.group(1))

    pred_match = re.search(r'Predictions\n\n(\d+)', markdown)
    if pred_match:
        predictions = int(pred_match.group(1))

    # Parse positions and trades
    positions = parse_positions_from_markdown(markdown)
    trades = parse_trades_from_markdown(markdown)

    # Calculate metrics
    category_concentration = calculate_category_concentration(positions, trades)
    insider_signals = detect_insider_signals(positions, trades, category_concentration)

    return TraderProfile(
        address=address,
        username=username,
        positions_value=positions_value,
        biggest_win=biggest_win,
        predictions=predictions,
        positions=positions,
        recent_trades=trades,
        category_concentration=category_concentration,
        insider_signals=insider_signals,
    )


def main():
    parser = argparse.ArgumentParser(description="Polymarket Insider Tracker")
    parser.add_argument("--trader", type=str, help="Trader address or username")
    parser.add_argument("--input-file", type=str, help="Load scraped data from file")
    parser.add_argument("--output", type=str, default="./output/insider_report.md",
                       help="Output file path")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown",
                       help="Output format")

    args = parser.parse_args()

    if args.input_file:
        # Load pre-scraped data
        with open(args.input_file) as f:
            if args.input_file.endswith(".json"):
                data = json.load(f)
                markdown = data.get("markdown", "")
            else:
                markdown = f.read()

        profile = parse_trader_from_scraped_data(markdown)
        report = generate_report(profile)

        # Save report
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report)

        print(report)
        print(f"\nReport saved to: {args.output}")

    else:
        print("Use --input-file to load scraped trader data")
        print("Or use the live_scraper.py to fetch data first")


if __name__ == "__main__":
    main()
