#!/usr/bin/env python3
"""
Daily Top 10 Trader Position Report

This script is designed to be run with Claude Code + Firecrawl MCP.
It scrapes the top 10 traders from Polymarket and generates a detailed
position report.

Usage:
    Run this script in Claude Code and it will guide you through
    scraping and generating the report.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Output directory for reports
REPORTS_DIR = Path(__file__).parent.parent / "output" / "daily_reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class Position:
    """A trader's position."""
    market: str
    outcome: str
    shares: float
    avg_price: float
    current_price: float
    value: float
    profit_loss: float
    profit_pct: float
    status: str  # Active, Won, Lost
    category: str


@dataclass
class TraderReport:
    """Report for a single trader."""
    rank: int
    username: str
    profit: float
    volume: float
    positions: List[Position]


def parse_money(text: str) -> float:
    """Parse money string to float."""
    if not text:
        return 0.0

    text = str(text).strip().replace(",", "").replace("$", "").replace("+", "")

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
        return float(text) * multiplier
    except ValueError:
        return 0.0


def format_money(value: float) -> str:
    """Format number as money string."""
    if abs(value) >= 1_000_000:
        return f"${value / 1_000_000:.2f}M"
    elif abs(value) >= 1_000:
        return f"${value / 1_000:.1f}K"
    else:
        return f"${value:,.0f}"


def format_position_description(pos: Position) -> str:
    """Generate detailed description for a position."""
    lines = []

    # Market name and status
    lines.append(f"**{pos.market}**")

    # Status explanation
    if pos.status == "Active":
        lines.append(f"  - **{pos.status}** - Position is still open (event hasn't resolved)")
    elif pos.status == "Won":
        lines.append(f"  - **{pos.status}** - Position resolved in trader's favor")
    else:
        lines.append(f"  - **{pos.status}** - Position resolved against trader")

    # Shares and entry price
    shares_fmt = f"{pos.shares:,.0f}"
    price_cents = int(pos.avg_price * 100)
    lines.append(f"  - **{shares_fmt} {pos.outcome} shares at {price_cents}c** - "
                f"Bought {shares_fmt} shares betting on '{pos.outcome}' at ${pos.avg_price:.2f} each")

    # Current value
    lines.append(f"  - **{format_money(pos.value)}** - Current position value")

    # Profit/Loss
    if pos.profit_loss >= 0:
        lines.append(f"  - **{format_money(pos.profit_loss)} (+{pos.profit_pct:.1f}%)** - "
                    f"Currently up {format_money(pos.profit_loss)} "
                    f"(price moved from {price_cents}c to ~{int(pos.current_price * 100)}c)")
    else:
        lines.append(f"  - **{format_money(pos.profit_loss)} ({pos.profit_pct:.1f}%)** - "
                    f"Currently down {format_money(abs(pos.profit_loss))}")

    # Category
    if pos.category:
        lines.append(f"  - **{pos.category}** tag - Category label")

    return "\n".join(lines)


def generate_trader_section(trader: TraderReport) -> str:
    """Generate report section for a single trader."""
    lines = []

    # Header
    lines.append(f"\n## #{trader.rank} - {trader.username}")
    lines.append(f"**Monthly Profit:** {format_money(trader.profit)} | "
                f"**Volume:** {format_money(trader.volume)}")
    lines.append(f"**Active Positions:** {len(trader.positions)}")
    lines.append("")

    # Positions
    if trader.positions:
        lines.append("### Positions")
        lines.append("")
        for pos in trader.positions:
            lines.append(format_position_description(pos))
            lines.append("")
    else:
        lines.append("*No active positions found*")
        lines.append("")

    return "\n".join(lines)


def generate_daily_report(traders: List[TraderReport]) -> str:
    """Generate the full daily report."""
    lines = []

    # Header
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines.append(f"# Daily Top 10 Trader Position Report")
    lines.append(f"**Date:** {date_str}")
    lines.append(f"**Generated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append("")

    # Summary
    lines.append("## Summary")
    total_positions = sum(len(t.positions) for t in traders)
    total_profit = sum(t.profit for t in traders)
    lines.append(f"- **Traders Analyzed:** {len(traders)}")
    lines.append(f"- **Total Positions:** {total_positions}")
    lines.append(f"- **Combined Profit:** {format_money(total_profit)}")
    lines.append("")

    # Quick overview table
    lines.append("## Leaderboard Overview")
    lines.append("| Rank | Trader | Profit | Positions |")
    lines.append("|------|--------|--------|-----------|")
    for t in traders:
        lines.append(f"| #{t.rank} | {t.username} | {format_money(t.profit)} | {len(t.positions)} |")
    lines.append("")

    # Detailed sections
    lines.append("---")
    lines.append("# Detailed Position Breakdown")

    for trader in traders:
        lines.append(generate_trader_section(trader))
        lines.append("---")

    return "\n".join(lines)


def save_report(report: str, filename: Optional[str] = None) -> Path:
    """Save report to file."""
    if filename is None:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        filename = f"top10_positions_{date_str}.md"

    filepath = REPORTS_DIR / filename
    filepath.write_text(report)
    return filepath


# ============================================================
# FIRECRAWL INTEGRATION - Run these steps in Claude Code
# ============================================================

SCRAPING_INSTRUCTIONS = """
## How to Generate the Daily Top 10 Report

Run these steps in Claude Code with Firecrawl MCP:

### Step 1: Scrape the Leaderboard
```
Use mcp__firecrawl__firecrawl_scrape with:
- url: https://polymarket.com/leaderboard?period=1M
- formats: ["markdown"]
```

### Step 2: Parse Top 10 Traders
From the leaderboard markdown, extract:
- Rank (1-10)
- Username
- Profit amount
- Profile URL

### Step 3: Scrape Each Trader's Profile
For each of the top 10 traders:
```
Use mcp__firecrawl__firecrawl_scrape with:
- url: https://polymarket.com/@{username}?tab=positions
- formats: ["markdown"]
```

### Step 4: Parse Positions
From each profile, extract:
- Market name
- Outcome (Yes/No or specific team)
- Number of shares
- Entry price (average cost)
- Current price
- Position value
- Profit/Loss amount and percentage
- Status (Active/Won/Lost)
- Category tags

### Step 5: Generate Report
Call generate_daily_report() with the parsed data and save_report() to save.

The report will be saved to: output/daily_reports/top10_positions_YYYY-MM-DD.md
"""


def parse_leaderboard_for_top10(markdown: str) -> List[Dict[str, Any]]:
    """
    Parse leaderboard markdown to get top 10 traders.
    Returns list of dicts with rank, username, profit, profile_url.
    """
    traders = []
    lines = markdown.split("\n")

    # Look for patterns like "#1", "1", followed by usernames and profit
    current_rank = 0

    for i, line in enumerate(lines):
        line = line.strip()

        # Check for rank indicators
        rank_match = re.match(r'^#?(\d+)$', line)
        if rank_match:
            current_rank = int(rank_match.group(1))
            if current_rank > 10:
                break

            # Look ahead for username and profit
            username = None
            profit = 0.0

            for j in range(i+1, min(i+15, len(lines))):
                check_line = lines[j].strip()

                # Username patterns
                if check_line.startswith("@"):
                    username = check_line[1:]
                    break
                elif re.match(r'^[A-Za-z][A-Za-z0-9_-]{2,}$', check_line):
                    if not any(x in check_line.lower() for x in ['profit', 'volume', 'rank']):
                        username = check_line

                # Profit
                if "+$" in check_line:
                    profit_match = re.search(r'\+?\$?([\d,.]+[KMB]?)', check_line)
                    if profit_match:
                        profit = parse_money(profit_match.group(1))

            if username and current_rank <= 10:
                traders.append({
                    "rank": current_rank,
                    "username": username,
                    "profit": profit,
                    "profile_url": f"https://polymarket.com/@{username}?tab=positions",
                })

    # Deduplicate and sort
    seen = set()
    unique_traders = []
    for t in traders:
        if t["username"] not in seen:
            seen.add(t["username"])
            unique_traders.append(t)

    unique_traders.sort(key=lambda x: x["rank"])
    return unique_traders[:10]


def parse_profile_positions(markdown: str, username: str) -> List[Position]:
    """
    Parse a trader's profile markdown to extract positions.
    """
    positions = []
    lines = markdown.split("\n")

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Look for position indicators
        if line in ["Won", "Lost", "Active"]:
            status = line

            # Search nearby lines for position details
            market = None
            outcome = "Yes"
            shares = 0.0
            avg_price = 0.0
            current_price = 0.0
            value = 0.0
            profit_pct = 0.0
            category = ""

            # Look around for details (5 lines before and after)
            for j in range(max(0, i-8), min(len(lines), i+8)):
                check_line = lines[j].strip()

                # Market name in brackets or as a link
                if "[" in check_line and "]" in check_line:
                    match = re.search(r'\[([^\]]+)\]', check_line)
                    if match and len(match.group(1)) > 5:
                        market = match.group(1)

                # Outcome
                if check_line in ["Yes", "No"]:
                    outcome = check_line

                # Shares count
                shares_match = re.search(r'([\d,]+)\s*(shares|Yes|No)', check_line, re.IGNORECASE)
                if shares_match:
                    shares = float(shares_match.group(1).replace(",", ""))

                # Price patterns like "at 55c" or "at $0.55"
                price_match = re.search(r'at\s+(\d+)c', check_line, re.IGNORECASE)
                if price_match:
                    avg_price = int(price_match.group(1)) / 100

                price_match2 = re.search(r'at\s+\$?(0?\.\d+)', check_line)
                if price_match2:
                    avg_price = float(price_match2.group(1))

                # Value and percentage
                if "$" in check_line and "%" in check_line:
                    val_match = re.search(r'\$([\d,.]+[KMB]?)', check_line)
                    pct_match = re.search(r'([+-]?\d+\.?\d*)%', check_line)
                    if val_match:
                        value = parse_money(val_match.group(1))
                    if pct_match:
                        profit_pct = float(pct_match.group(1))

                # Just value
                elif check_line.startswith("$"):
                    value = parse_money(check_line)

                # Category tags (lowercase words)
                if re.match(r'^[a-z_]+$', check_line) and len(check_line) > 2:
                    category = check_line

            if market and value > 0:
                # Calculate derived values
                if shares > 0 and avg_price > 0:
                    current_price = value / shares if shares > 0 else avg_price
                else:
                    current_price = avg_price

                profit_loss = value * (profit_pct / 100) if profit_pct else 0

                positions.append(Position(
                    market=market,
                    outcome=outcome,
                    shares=shares,
                    avg_price=avg_price,
                    current_price=current_price,
                    value=value,
                    profit_loss=profit_loss,
                    profit_pct=profit_pct,
                    status=status,
                    category=category,
                ))

        i += 1

    return positions


if __name__ == "__main__":
    print(SCRAPING_INSTRUCTIONS)
    print("\n" + "="*60)
    print("To generate a report, run this script in Claude Code")
    print("and follow the Firecrawl scraping instructions above.")
    print("="*60)
