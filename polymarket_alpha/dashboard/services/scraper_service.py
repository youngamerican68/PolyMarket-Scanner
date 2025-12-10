#!/usr/bin/env python3
"""
Scraper Service

Integrates with Firecrawl MCP to scrape Polymarket data.
This module provides functions to be called from Claude Code.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dashboard.services.discovery_service import (
    analyze_trader,
    parse_leaderboard,
    LeaderboardEntry,
    DiscoveryResult,
)
from dashboard.services.trader_service import (
    TraderService,
    Trader,
    Position,
    Trade,
    InsiderSignal,
)

# URLs
LEADERBOARD_URL = "https://polymarket.com/leaderboard?period=1M"
PROFILE_BASE_URL = "https://polymarket.com/@"


def get_leaderboard_url(period: str = "1M") -> str:
    """Get leaderboard URL for a given period."""
    return f"https://polymarket.com/leaderboard?period={period}"


def get_profile_url(trader_id: str, tab: str = "positions") -> str:
    """Get profile URL for a trader."""
    return f"https://polymarket.com/@{trader_id}?tab={tab}"


def parse_leaderboard_markdown(markdown: str) -> List[Dict[str, Any]]:
    """
    Parse leaderboard data from scraped markdown.

    Returns list of traders with:
    - rank
    - username
    - profit
    - volume (if available)
    """
    traders = []
    lines = markdown.split("\n")

    rank = 0
    i = 0

    while i < len(lines):
        line = lines[i].strip()

        # Look for rank indicators (1, 2, 3, etc. or #1, #2, etc.)
        rank_match = re.match(r'^#?(\d+)$', line)
        if rank_match:
            current_rank = int(rank_match.group(1))

            # Look ahead for username and profit
            username = None
            profit = 0.0

            for j in range(i+1, min(i+10, len(lines))):
                check_line = lines[j].strip()

                # Username (often starts with @ or is a wallet-like string)
                if check_line.startswith("@"):
                    username = check_line[1:]
                elif re.match(r'^0x[a-fA-F0-9]+$', check_line) or re.match(r'^[A-Za-z][A-Za-z0-9_-]{2,}$', check_line):
                    if not username:
                        username = check_line

                # Profit (positive money value)
                if "+$" in check_line or (check_line.startswith("$") and "-" not in check_line):
                    profit_match = re.search(r'\$?([\d,.]+[KMB]?)', check_line)
                    if profit_match:
                        profit = parse_money(profit_match.group(1))

            if username:
                traders.append({
                    "rank": current_rank,
                    "username": username,
                    "address": username,
                    "profit": profit,
                    "profile_url": get_profile_url(username),
                })

        # Also look for usernames with profit on same line
        if "@" in line:
            username_match = re.search(r'@([A-Za-z0-9_-]+)', line)
            profit_match = re.search(r'\+?\$?([\d,.]+[KMB]?)', line)

            if username_match:
                rank += 1
                username = username_match.group(1)
                profit = parse_money(profit_match.group(1)) if profit_match else 0.0

                # Avoid duplicates
                if not any(t["username"] == username for t in traders):
                    traders.append({
                        "rank": rank,
                        "username": username,
                        "address": username,
                        "profit": profit,
                        "profile_url": get_profile_url(username),
                    })

        i += 1

    return traders


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


def parse_profile_markdown(markdown: str) -> Dict[str, Any]:
    """
    Parse a trader's profile from scraped markdown.

    Returns dict with:
    - username
    - joined
    - views
    - positions_value
    - biggest_win
    - predictions
    - profit_1w
    - profit_1m
    - positions (list)
    - trades (list)
    """
    profile = {
        "username": "",
        "joined": "",
        "views": "",
        "positions_value": 0.0,
        "biggest_win": 0.0,
        "predictions": 0,
        "profit_1w": 0.0,
        "profit_1m": 0.0,
        "positions": [],
        "trades": [],
    }

    lines = markdown.split("\n")

    for i, line in enumerate(lines):
        line = line.strip()

        # Username - first line that looks like a username
        if not profile["username"] and re.match(r'^[A-Za-z0-9_-]{3,}$', line):
            profile["username"] = line

        # Joined
        if "joined" in line.lower():
            match = re.search(r'Joined\s+(\w+\s+\d{4})', line, re.IGNORECASE)
            if match:
                profile["joined"] = match.group(1)

        # Views
        if "views" in line.lower():
            match = re.search(r'([\d.]+[KMB]?)\s*views', line, re.IGNORECASE)
            if match:
                profile["views"] = match.group(1)

        # Positions Value
        if "positions value" in line.lower():
            next_line = lines[i+1].strip() if i+1 < len(lines) else ""
            match = re.search(r'\$([\d,.]+[KMB]?)', next_line)
            if match:
                profile["positions_value"] = parse_money(match.group(1))

        # Biggest Win
        if "biggest win" in line.lower():
            next_line = lines[i+1].strip() if i+1 < len(lines) else ""
            match = re.search(r'\$([\d,.]+[KMB]?)', next_line)
            if match:
                profile["biggest_win"] = parse_money(match.group(1))

        # Predictions
        if "predictions" in line.lower():
            next_line = lines[i+1].strip() if i+1 < len(lines) else ""
            match = re.search(r'(\d+)', next_line)
            if match:
                profile["predictions"] = int(match.group(1))

        # Profit
        if "profit" in line.lower() or "+$" in line:
            match = re.search(r'\+?\$([\d,.]+[KMB]?)', line)
            if match:
                val = parse_money(match.group(1))
                if "1w" in line.lower() or "week" in line.lower():
                    profile["profit_1w"] = val
                elif "1m" in line.lower() or "month" in line.lower():
                    profile["profit_1m"] = val
                elif profile["profit_1w"] == 0:
                    profile["profit_1w"] = val

    # Parse positions
    profile["positions"] = parse_positions(markdown)

    # Parse trades
    profile["trades"] = parse_trades(markdown)

    return profile


def parse_positions(markdown: str) -> List[Dict[str, Any]]:
    """Parse positions from markdown."""
    positions = []
    lines = markdown.split("\n")

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Look for result indicators
        if line in ["Won", "Lost", "Active"]:
            result = line

            # Look for market info nearby
            market = None
            outcome = None
            value = 0.0
            profit_pct = 0.0

            for j in range(max(0, i-5), min(len(lines), i+5)):
                check_line = lines[j].strip()

                # Market name (in brackets)
                if "[" in check_line and "]" in check_line:
                    match = re.search(r'\[([^\]]+)\]', check_line)
                    if match and len(match.group(1)) > 10:
                        market = match.group(1)

                # Outcome
                if check_line in ["Yes", "No"]:
                    outcome = check_line

                # Value and percentage
                if "$" in check_line and "%" in check_line:
                    val_match = re.search(r'\$([\d,.]+)', check_line)
                    pct_match = re.search(r'([\d.]+)%', check_line)
                    if val_match:
                        value = parse_money(val_match.group(1))
                    if pct_match:
                        profit_pct = float(pct_match.group(1))

            if market:
                positions.append({
                    "market": market,
                    "outcome": outcome or "Unknown",
                    "value": value,
                    "profit_pct": profit_pct,
                    "result": result,
                })

        i += 1

    return positions


def parse_trades(markdown: str) -> List[Dict[str, Any]]:
    """Parse trades from markdown."""
    trades = []
    lines = markdown.split("\n")

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        if line in ["Buy", "Sell", "Redeem"]:
            trade_type = line
            market = None
            amount = 0.0
            timestamp = "Unknown"

            for j in range(i+1, min(len(lines), i+8)):
                check_line = lines[j].strip()

                # Market
                if "[" in check_line and "]" in check_line:
                    match = re.search(r'\[([^\]]+)\]', check_line)
                    if match:
                        market = match.group(1)

                # Amount
                if check_line.startswith("$"):
                    amount = parse_money(check_line)

                # Timestamp
                if "ago" in check_line.lower():
                    timestamp = check_line

            if market:
                trades.append({
                    "trade_type": trade_type,
                    "market": market,
                    "amount": amount,
                    "timestamp": timestamp,
                })

        i += 1

    return trades


def convert_to_trader(profile_data: Dict[str, Any], discovery_result: DiscoveryResult) -> Trader:
    """Convert parsed data to Trader object for the dashboard."""

    positions = [
        Position(
            market=p.get("market", ""),
            market_url="",
            outcome=p.get("outcome", "Unknown"),
            shares=p.get("shares", 0),
            avg_price=p.get("avg_price", 0),
            current_price=p.get("current_price", 0),
            value=p.get("value", 0),
            profit_loss=p.get("profit_loss", 0),
            profit_pct=p.get("profit_pct", 0),
            result=p.get("result", "Active"),
            categories=p.get("categories", []),
        )
        for p in profile_data.get("positions", [])
    ]

    trades = [
        Trade(
            timestamp=t.get("timestamp", "Unknown"),
            trade_type=t.get("trade_type", "Unknown"),
            market=t.get("market", ""),
            outcome=t.get("outcome"),
            shares=t.get("shares", 0),
            amount=t.get("amount", 0),
            price=t.get("price"),
            categories=t.get("categories", []),
        )
        for t in profile_data.get("trades", [])
    ]

    signals = [
        InsiderSignal(
            severity=s.severity,
            title=s.title,
            description=s.description,
            category=s.evidence.get("category") if hasattr(s, "evidence") else None,
        )
        for s in discovery_result.signals
    ]

    return Trader(
        address=profile_data.get("username", "Unknown"),
        username=profile_data.get("username", "Unknown"),
        joined=profile_data.get("joined", ""),
        views=profile_data.get("views", ""),
        positions_value=profile_data.get("positions_value", 0),
        biggest_win=profile_data.get("biggest_win", 0),
        predictions=profile_data.get("predictions", 0),
        profit_1w=profile_data.get("profit_1w", 0),
        profit_1m=profile_data.get("profit_1m", 0),
        rank_monthly=discovery_result.rank,
        positions=positions,
        recent_trades=trades,
        category_concentration=discovery_result.category_concentration,
        insider_signals=signals,
        last_updated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    )


# Instructions for Claude Code integration
SCRAPE_INSTRUCTIONS = """
## How to Use Firecrawl to Discover Insiders

### Step 1: Scrape the Leaderboard
```
Use mcp__firecrawl__firecrawl_scrape with:
- url: https://polymarket.com/leaderboard?period=1M
- formats: ["markdown"]
```

### Step 2: Parse the Leaderboard
Pass the markdown to parse_leaderboard_markdown() to get list of traders.

### Step 3: For Each Top Trader, Scrape Their Profile
```
Use mcp__firecrawl__firecrawl_scrape with:
- url: https://polymarket.com/@{username}?tab=positions
- formats: ["markdown"]
```

### Step 4: Analyze Each Trader
Pass the profile markdown to analyze_trader() to detect insider patterns.

### Step 5: Add to Dashboard
If is_potential_insider is True, add to the watched traders list.
"""
