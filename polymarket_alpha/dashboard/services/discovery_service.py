#!/usr/bin/env python3
"""
Discovery Service

Automatically discovers potential insiders by:
1. Scraping the Polymarket leaderboard
2. Analyzing each trader's profile
3. Detecting insider patterns
4. Flagging suspicious traders
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from utils.logging_config import get_logger

logger = get_logger(__name__)


# Insider detection thresholds
THRESHOLDS = {
    "category_concentration": 0.50,  # 50%+ in one category = suspicious
    "big_winner_pct": 50,            # 50%+ gain = big winner
    "big_winner_count": 3,           # 3+ big winners = suspicious
    "cluster_buy_count": 3,          # 3+ buys on same market = cluster
    "large_position_value": 100_000, # $100K+ = large position
    "high_redemption_count": 5,      # 5+ redemptions = high win rate
    "min_volume": 10_000,            # Minimum volume to consider
    "longshot_threshold": 0.20,      # 20% odds or less = longshot
    "longshot_win_pct": 200,         # 200%+ gain on longshot = very suspicious
}

# Category keywords for detection
CATEGORY_KEYWORDS = {
    "google": [
        "google", "alphabet", "deepmind", "waymo", "gemini", "bard",
        "youtube", "android", "chrome", "pixel", "nest", "search",
        "searched", "year in search"
    ],
    "apple": [
        "apple", "iphone", "ipad", "mac", "ios", "wwdc", "tim cook",
        "vision pro", "airpods", "apple watch"
    ],
    "openai": [
        "openai", "chatgpt", "gpt-5", "gpt-4", "sam altman", "dall-e", "sora"
    ],
    "tesla": [
        "tesla", "elon musk", "cybertruck", "spacex", "starlink"
    ],
    "meta": [
        "meta", "facebook", "instagram", "whatsapp", "zuckerberg", "llama", "threads"
    ],
    "microsoft": [
        "microsoft", "bing", "copilot", "azure", "xbox", "satya nadella"
    ],
    "crypto": [
        "bitcoin", "ethereum", "crypto", "btc", "eth", "solana", "binance"
    ],
    "politics": [
        "trump", "biden", "election", "president", "congress", "senate", "vote"
    ],
}


@dataclass
class LeaderboardEntry:
    """A trader from the leaderboard."""
    rank: int
    username: str
    address: str
    profit: float
    volume: float
    profile_url: str


@dataclass
class Position:
    """A trader's position."""
    market: str
    outcome: str
    shares: float
    avg_price: float
    current_price: float
    value: float
    profit_pct: float
    result: str  # Won, Lost, Active
    categories: List[str] = field(default_factory=list)


@dataclass
class Trade:
    """A single trade."""
    timestamp: str
    trade_type: str
    market: str
    outcome: Optional[str]
    shares: float
    amount: float
    price: Optional[float]
    categories: List[str] = field(default_factory=list)


@dataclass
class InsiderSignal:
    """An insider trading signal."""
    severity: str  # high, medium, low
    signal_type: str
    title: str
    description: str
    evidence: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DiscoveryResult:
    """Result of analyzing a trader."""
    address: str
    username: str
    rank: Optional[int]
    profit: float
    volume: float
    positions_value: float
    positions: List[Position]
    trades: List[Trade]
    category_concentration: Dict[str, float]
    signals: List[InsiderSignal]
    insider_score: float  # 0-100, higher = more suspicious
    is_potential_insider: bool
    analyzed_at: str


def parse_money(text: str) -> float:
    """Parse money string like '$1.2M' to float."""
    if not text:
        return 0.0

    text = str(text).strip().replace(",", "").replace("$", "")

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
    """Identify categories for a market."""
    if not market_text:
        return []

    market_lower = market_text.lower()
    categories = []

    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in market_lower for kw in keywords):
            categories.append(category)

    return categories


def parse_leaderboard(markdown: str) -> List[LeaderboardEntry]:
    """Parse leaderboard from scraped markdown."""
    entries = []

    # Look for trader entries in the leaderboard
    # Format varies but typically includes rank, username, profit, volume
    lines = markdown.split("\n")

    rank = 0
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Look for profile links
        if "polymarket.com/@" in line or line.startswith("@"):
            rank += 1

            # Extract username
            username_match = re.search(r'@([A-Za-z0-9_-]+)', line)
            if username_match:
                username = username_match.group(1)

                # Look for profit/volume in nearby lines
                profit = 0.0
                volume = 0.0

                for j in range(max(0, i-2), min(len(lines), i+5)):
                    check_line = lines[j]

                    # Look for money values
                    money_matches = re.findall(r'\$[\d,.]+[KMB]?', check_line)
                    for match in money_matches:
                        val = parse_money(match)
                        if "profit" in check_line.lower() or "+" in check_line:
                            profit = val
                        elif "volume" in check_line.lower():
                            volume = val
                        elif profit == 0:
                            profit = val

                entries.append(LeaderboardEntry(
                    rank=rank,
                    username=username,
                    address=username,  # Often same as username
                    profit=profit,
                    volume=volume,
                    profile_url=f"https://polymarket.com/@{username}",
                ))
        i += 1

    return entries


def parse_trader_profile(markdown: str) -> Tuple[Dict[str, Any], List[Position], List[Trade]]:
    """Parse a trader's profile from scraped markdown."""
    profile = {
        "username": "",
        "joined": "",
        "views": "",
        "positions_value": 0.0,
        "biggest_win": 0.0,
        "predictions": 0,
        "profit_1w": 0.0,
        "profit_1m": 0.0,
    }
    positions = []
    trades = []

    lines = markdown.split("\n")

    # Extract profile info
    for i, line in enumerate(lines):
        line = line.strip()

        # Username (usually first significant text)
        if i < 5 and re.match(r'^[A-Za-z0-9_-]+$', line) and len(line) > 2:
            profile["username"] = line

        # Joined date
        if "joined" in line.lower():
            match = re.search(r'Joined\s+(\w+\s+\d{4})', line, re.IGNORECASE)
            if match:
                profile["joined"] = match.group(1)

        # Stats
        if "positions value" in line.lower():
            match = re.search(r'\$([\d,.]+[KMB]?)', lines[i+1] if i+1 < len(lines) else "")
            if match:
                profile["positions_value"] = parse_money(match.group(1))

        if "biggest win" in line.lower():
            match = re.search(r'\$([\d,.]+[KMB]?)', lines[i+1] if i+1 < len(lines) else "")
            if match:
                profile["biggest_win"] = parse_money(match.group(1))

        if "predictions" in line.lower():
            match = re.search(r'(\d+)', lines[i+1] if i+1 < len(lines) else "")
            if match:
                profile["predictions"] = int(match.group(1))

        # Profit/Loss
        if "profit" in line.lower() or "+$" in line:
            match = re.search(r'[+]?\$([\d,.]+[KMB]?)', line)
            if match:
                val = parse_money(match.group(1))
                if "week" in line.lower() or "1w" in line.lower():
                    profile["profit_1w"] = val
                elif "month" in line.lower() or "1m" in line.lower():
                    profile["profit_1m"] = val

    # Parse positions
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Look for position indicators
        if line in ["Won", "Lost", "Active"] or re.match(r'^(Yes|No)$', line):
            result = line if line in ["Won", "Lost", "Active"] else "Active"
            outcome = line if line in ["Yes", "No"] else None

            # Look for market name nearby
            market = None
            value = 0.0
            profit_pct = 0.0
            shares = 0.0
            avg_price = 0.0
            current_price = 0.0

            for j in range(max(0, i-3), min(len(lines), i+5)):
                check_line = lines[j].strip()

                # Market name (usually in brackets or standalone text)
                if "[" in check_line and "](" in check_line:
                    match = re.search(r'\[([^\]]+)\]', check_line)
                    if match:
                        market = match.group(1)

                # Outcome
                if check_line in ["Yes", "No"]:
                    outcome = check_line

                # Value and profit
                if "$" in check_line and "%" in check_line:
                    val_match = re.search(r'\$([\d,.]+)', check_line)
                    pct_match = re.search(r'([\d.]+)%', check_line)
                    if val_match:
                        value = parse_money(val_match.group(1))
                    if pct_match:
                        profit_pct = float(pct_match.group(1))

                # Shares
                if "shares" in check_line.lower():
                    share_match = re.search(r'([\d,]+)\s*shares', check_line, re.IGNORECASE)
                    if share_match:
                        shares = float(share_match.group(1).replace(",", ""))

                    price_match = re.search(r'at\s*(\d+)[¢c]', check_line)
                    if price_match:
                        avg_price = float(price_match.group(1)) / 100

            if market and outcome:
                categories = categorize_market(market)
                positions.append(Position(
                    market=market,
                    outcome=outcome,
                    shares=shares,
                    avg_price=avg_price,
                    current_price=current_price,
                    value=value,
                    profit_pct=profit_pct,
                    result=result,
                    categories=categories,
                ))

        # Look for trade indicators
        if line in ["Buy", "Sell", "Redeem"]:
            trade_type = line
            market = None
            outcome = None
            amount = 0.0
            shares = 0.0
            price = None
            timestamp = "Unknown"

            for j in range(i+1, min(len(lines), i+6)):
                check_line = lines[j].strip()

                # Market
                if "[" in check_line and "](" in check_line:
                    match = re.search(r'\[([^\]]+)\]', check_line)
                    if match:
                        market = match.group(1)

                # Outcome and price
                if re.match(r'^(Yes|No)\s+\d+[¢c]', check_line):
                    parts = check_line.split()
                    outcome = parts[0]
                    price = float(parts[1].replace("¢", "").replace("c", "")) / 100

                # Amount
                if check_line.startswith("$") and "%" not in check_line:
                    amount = parse_money(check_line)

                # Shares
                if "shares" in check_line.lower():
                    match = re.search(r'([\d,]+)\s*shares', check_line, re.IGNORECASE)
                    if match:
                        shares = float(match.group(1).replace(",", ""))

                # Timestamp
                if "ago" in check_line.lower():
                    timestamp = check_line

            if market:
                categories = categorize_market(market)
                trades.append(Trade(
                    timestamp=timestamp,
                    trade_type=trade_type,
                    market=market,
                    outcome=outcome,
                    shares=shares,
                    amount=amount,
                    price=price,
                    categories=categories,
                ))

        i += 1

    return profile, positions, trades


def calculate_category_concentration(positions: List[Position]) -> Dict[str, float]:
    """Calculate what % of portfolio is in each category."""
    if not positions:
        return {}

    total_value = sum(p.value for p in positions)
    if total_value == 0:
        return {}

    category_value: Dict[str, float] = {}
    for pos in positions:
        for cat in pos.categories:
            category_value[cat] = category_value.get(cat, 0) + pos.value

    return {cat: val / total_value for cat, val in category_value.items()}


def detect_insider_signals(
    positions: List[Position],
    trades: List[Trade],
    category_concentration: Dict[str, float],
    profit: float,
) -> Tuple[List[InsiderSignal], float]:
    """
    Detect insider trading signals and calculate insider score.

    Returns:
        (list of signals, insider score 0-100)
    """
    signals = []
    score = 0.0

    # 1. Category concentration
    for cat, conc in category_concentration.items():
        if conc >= THRESHOLDS["category_concentration"]:
            severity = "high" if conc >= 0.80 else "medium"
            signals.append(InsiderSignal(
                severity=severity,
                signal_type="category_concentration",
                title=f"{conc:.0%} {cat.title()} Concentration",
                description=f"Portfolio heavily concentrated in {cat}-related markets",
                evidence={"category": cat, "concentration": conc},
            ))
            score += 25 if severity == "high" else 15

    # 2. Big winners
    big_winners = [p for p in positions if p.profit_pct >= THRESHOLDS["big_winner_pct"]]
    if len(big_winners) >= THRESHOLDS["big_winner_count"]:
        signals.append(InsiderSignal(
            severity="medium",
            signal_type="big_winners",
            title=f"{len(big_winners)} Big Winners",
            description=f"Multiple positions with >50% gains",
            evidence={"count": len(big_winners), "positions": [p.market for p in big_winners[:3]]},
        ))
        score += 15

    # 3. Longshot wins (bought at <20% odds, now winning big)
    longshot_wins = [
        p for p in positions
        if p.avg_price <= THRESHOLDS["longshot_threshold"]
        and p.profit_pct >= THRESHOLDS["longshot_win_pct"]
    ]
    if longshot_wins:
        for p in longshot_wins:
            signals.append(InsiderSignal(
                severity="high",
                signal_type="longshot_win",
                title=f"Longshot Win: {p.profit_pct:.0f}% gain",
                description=f"Bought '{p.market[:40]}...' at {p.avg_price:.0%} odds",
                evidence={"market": p.market, "buy_price": p.avg_price, "profit_pct": p.profit_pct},
            ))
            score += 20

    # 4. Cluster buying
    market_buy_counts: Dict[str, int] = {}
    for trade in trades:
        if trade.trade_type == "Buy":
            market_buy_counts[trade.market] = market_buy_counts.get(trade.market, 0) + 1

    cluster_markets = [(m, c) for m, c in market_buy_counts.items() if c >= THRESHOLDS["cluster_buy_count"]]
    if cluster_markets:
        signals.append(InsiderSignal(
            severity="medium",
            signal_type="cluster_buying",
            title=f"Cluster Buying Detected",
            description=f"Multiple buy orders on {len(cluster_markets)} markets",
            evidence={"markets": [m for m, _ in cluster_markets[:3]], "counts": dict(cluster_markets[:3])},
        ))
        score += 10

    # 5. Large positions
    large_positions = [p for p in positions if p.value >= THRESHOLDS["large_position_value"]]
    if large_positions:
        signals.append(InsiderSignal(
            severity="medium",
            signal_type="large_positions",
            title=f"{len(large_positions)} Large Positions",
            description=f"Positions over $100K suggest high confidence",
            evidence={"count": len(large_positions), "total_value": sum(p.value for p in large_positions)},
        ))
        score += 10

    # 6. High redemption rate
    redemptions = [t for t in trades if t.trade_type == "Redeem"]
    if len(redemptions) >= THRESHOLDS["high_redemption_count"]:
        signals.append(InsiderSignal(
            severity="medium",
            signal_type="high_redemptions",
            title=f"{len(redemptions)} Winning Redemptions",
            description="High number of successful bet resolutions",
            evidence={"count": len(redemptions)},
        ))
        score += 10

    # 7. Exceptional profit
    if profit >= 500_000:
        signals.append(InsiderSignal(
            severity="high" if profit >= 1_000_000 else "medium",
            signal_type="exceptional_profit",
            title=f"${profit:,.0f} Profit",
            description="Exceptional returns suggest unusual accuracy",
            evidence={"profit": profit},
        ))
        score += 15 if profit >= 1_000_000 else 10

    # Cap score at 100
    score = min(100, score)

    return signals, score


def analyze_trader(
    profile_markdown: str,
    rank: Optional[int] = None,
    leaderboard_profit: Optional[float] = None,
) -> DiscoveryResult:
    """
    Analyze a trader's profile for insider patterns.

    Args:
        profile_markdown: Scraped markdown of trader's profile page
        rank: Their leaderboard rank (if known)
        leaderboard_profit: Profit from leaderboard (if known)

    Returns:
        DiscoveryResult with analysis
    """
    profile, positions, trades = parse_trader_profile(profile_markdown)

    category_concentration = calculate_category_concentration(positions)

    profit = leaderboard_profit or profile.get("profit_1m", 0) or profile.get("profit_1w", 0)

    signals, score = detect_insider_signals(
        positions, trades, category_concentration, profit
    )

    # Sort signals by severity
    severity_order = {"high": 0, "medium": 1, "low": 2}
    signals.sort(key=lambda s: severity_order.get(s.severity, 3))

    # Determine if potential insider (score >= 40 or any high severity signals)
    is_potential_insider = score >= 40 or any(s.severity == "high" for s in signals)

    return DiscoveryResult(
        address=profile.get("username", "Unknown"),
        username=profile.get("username", "Unknown"),
        rank=rank,
        profit=profit,
        volume=0,  # Would need from leaderboard
        positions_value=profile.get("positions_value", sum(p.value for p in positions)),
        positions=positions,
        trades=trades,
        category_concentration=category_concentration,
        signals=signals,
        insider_score=score,
        is_potential_insider=is_potential_insider,
        analyzed_at=datetime.now(timezone.utc).isoformat(),
    )
