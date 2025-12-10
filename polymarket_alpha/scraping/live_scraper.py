#!/usr/bin/env python3
"""
Polymarket Live Scraper

Scrapes Polymarket leaderboard and trader activity pages in real-time.
No external Manus dependency - runs independently.

Workflow:
1. Scrape top traders from leaderboard
2. For each trader, scrape their activity
3. Analyze for patterns (high win rates, category concentration)
4. Flag potential insiders

Usage:
    python live_scraper.py --top-traders
    python live_scraper.py --trader 0xafEe
    python live_scraper.py --find-insiders
"""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.logging_config import get_logger

logger = get_logger(__name__)

# Polymarket URLs
LEADERBOARD_URL = "https://polymarket.com/leaderboard"
PROFILE_BASE_URL = "https://polymarket.com/@"

# Categories to watch for insider patterns
INSIDER_CATEGORIES = {
    "google": [
        "google", "alphabet", "deepmind", "waymo", "gemini", "bard",
        "youtube", "android", "chrome", "pixel", "nest", "search"
    ],
    "apple": [
        "apple", "iphone", "ipad", "mac", "ios", "wwdc", "tim cook",
        "vision pro", "airpods", "apple watch"
    ],
    "openai": [
        "openai", "chatgpt", "gpt-5", "gpt-4", "sam altman", "dall-e", "sora"
    ],
    "tesla": [
        "tesla", "elon musk", "cybertruck", "model", "spacex", "starlink"
    ],
    "meta": [
        "meta", "facebook", "instagram", "whatsapp", "zuckerberg", "llama", "threads"
    ],
    "microsoft": [
        "microsoft", "bing", "copilot", "azure", "xbox", "satya nadella"
    ],
}


@dataclass
class Trade:
    """Represents a single trade."""
    timestamp: datetime
    trade_type: str  # Buy, Sell, Redeem
    market: str
    amount: float
    outcome: Optional[str] = None  # Yes/No position
    resolved: bool = False
    won: Optional[bool] = None


@dataclass
class TraderProfile:
    """Represents a trader's profile and stats."""
    address: str
    username: str
    profit_loss: float
    volume: float
    markets_traded: int
    win_rate: float
    trades: List[Trade]
    category_concentration: Dict[str, float]  # category -> % of trades


def parse_money(text: str) -> float:
    """Parse money string like '$1.2M' or '$500.00' to float."""
    if not text:
        return 0.0

    text = text.strip().replace(",", "").replace("$", "")

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


def parse_relative_time(text: str) -> Optional[datetime]:
    """Parse relative timestamps like '2 hours ago'."""
    if not text:
        return None

    now = datetime.now(timezone.utc)
    text = text.lower().strip()

    if "just now" in text:
        return now

    match = re.search(r"(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago", text)
    if match:
        value = int(match.group(1))
        unit = match.group(2)

        if unit == "second":
            return now - timedelta(seconds=value)
        elif unit == "minute":
            return now - timedelta(minutes=value)
        elif unit == "hour":
            return now - timedelta(hours=value)
        elif unit == "day":
            return now - timedelta(days=value)
        elif unit == "week":
            return now - timedelta(weeks=value)
        elif unit == "month":
            return now - timedelta(days=value * 30)

    return None


def categorize_market(market_text: str) -> List[str]:
    """Identify which categories a market belongs to."""
    if not market_text:
        return []

    market_lower = market_text.lower()
    categories = []

    for category, keywords in INSIDER_CATEGORIES.items():
        if any(kw in market_lower for kw in keywords):
            categories.append(category)

    return categories


def calculate_category_concentration(trades: List[Trade]) -> Dict[str, float]:
    """Calculate what % of trades fall into each category."""
    if not trades:
        return {}

    category_counts: Dict[str, int] = {}

    for trade in trades:
        categories = categorize_market(trade.market)
        for cat in categories:
            category_counts[cat] = category_counts.get(cat, 0) + 1

    total = len(trades)
    return {cat: count / total for cat, count in category_counts.items()}


def is_potential_insider(profile: TraderProfile) -> Tuple[bool, List[str]]:
    """
    Determine if a trader shows insider-like patterns.

    Returns:
        (is_suspicious, list of reasons)
    """
    reasons = []

    # High win rate (>85%) with significant volume
    if profile.win_rate > 0.85 and profile.volume > 10000:
        reasons.append(f"High win rate ({profile.win_rate:.1%}) with ${profile.volume:,.0f} volume")

    # Very high category concentration (>50% in one category)
    for category, concentration in profile.category_concentration.items():
        if concentration > 0.5:
            reasons.append(f"Heavy concentration in {category} ({concentration:.1%} of trades)")

    # Large profits
    if profile.profit_loss > 100000:
        reasons.append(f"Large profits (${profile.profit_loss:,.0f})")

    # Winning streak on specific category
    # TODO: Add streak detection

    return len(reasons) > 0, reasons


class PolymarketScraper:
    """Live scraper for Polymarket data."""

    def __init__(self, use_cache: bool = True, cache_ttl: int = 300):
        """
        Initialize scraper.

        Args:
            use_cache: Whether to cache results
            cache_ttl: Cache time-to-live in seconds
        """
        if not HTTPX_AVAILABLE:
            raise ImportError("httpx required. Run: pip install httpx")

        self.client = httpx.Client(
            timeout=30.0,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            }
        )
        self.use_cache = use_cache
        self.cache_ttl = cache_ttl
        self._cache: Dict[str, Tuple[datetime, Any]] = {}

    def _get_cached(self, key: str) -> Optional[Any]:
        """Get cached result if not expired."""
        if not self.use_cache or key not in self._cache:
            return None

        cached_time, data = self._cache[key]
        if datetime.now() - cached_time > timedelta(seconds=self.cache_ttl):
            del self._cache[key]
            return None

        return data

    def _set_cache(self, key: str, data: Any) -> None:
        """Cache a result."""
        if self.use_cache:
            self._cache[key] = (datetime.now(), data)

    def scrape_leaderboard(self, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Scrape the Polymarket leaderboard.

        Note: This requires browser automation or API access.
        For now, returns structure for manual data or API integration.

        Args:
            limit: Max traders to return

        Returns:
            List of trader dicts with address, username, profit, volume
        """
        cache_key = f"leaderboard_{limit}"
        cached = self._get_cached(cache_key)
        if cached:
            return cached

        logger.info(f"Scraping leaderboard for top {limit} traders...")

        # NOTE: Polymarket's leaderboard is JS-rendered
        # Would need Firecrawl, Playwright, or their API
        # For now, return placeholder structure

        traders = []

        # TODO: Integrate with Firecrawl MCP or Polymarket API
        logger.warning("Live leaderboard scraping requires Firecrawl or API access")
        logger.info("Use --load-file to load pre-scraped data instead")

        self._set_cache(cache_key, traders)
        return traders

    def scrape_trader_activity(
        self,
        trader_id: str,
        hours: int = 24,
    ) -> List[Trade]:
        """
        Scrape a trader's activity.

        Args:
            trader_id: Wallet address or username
            hours: How many hours back to look

        Returns:
            List of Trade objects
        """
        cache_key = f"activity_{trader_id}_{hours}"
        cached = self._get_cached(cache_key)
        if cached:
            return cached

        url = f"{PROFILE_BASE_URL}{trader_id}?tab=activity"
        logger.info(f"Scraping activity for {trader_id}...")

        # NOTE: Activity page is JS-rendered
        # Would need Firecrawl or browser automation

        trades = []

        # TODO: Integrate with Firecrawl MCP
        logger.warning(f"Live activity scraping requires Firecrawl")
        logger.info(f"URL to scrape: {url}")

        self._set_cache(cache_key, trades)
        return trades

    def get_trader_profile(self, trader_id: str) -> Optional[TraderProfile]:
        """
        Build complete trader profile with analysis.

        Args:
            trader_id: Wallet address or username

        Returns:
            TraderProfile with stats and trades
        """
        trades = self.scrape_trader_activity(trader_id, hours=168)  # 7 days

        if not trades:
            logger.warning(f"No trades found for {trader_id}")
            return None

        # Calculate stats
        total_profit = sum(t.amount for t in trades if t.won)
        total_loss = sum(t.amount for t in trades if t.won == False)
        wins = sum(1 for t in trades if t.won)
        resolved = sum(1 for t in trades if t.resolved)

        win_rate = wins / resolved if resolved > 0 else 0
        category_conc = calculate_category_concentration(trades)

        return TraderProfile(
            address=trader_id,
            username=trader_id,  # Would get from profile
            profit_loss=total_profit - total_loss,
            volume=sum(t.amount for t in trades),
            markets_traded=len(set(t.market for t in trades)),
            win_rate=win_rate,
            trades=trades,
            category_concentration=category_conc,
        )

    def close(self):
        """Close HTTP client."""
        self.client.close()


def load_trades_from_json(file_path: str) -> List[Trade]:
    """Load trades from a JSON file."""
    path = Path(file_path)
    if not path.exists():
        logger.error(f"File not found: {file_path}")
        return []

    with open(path) as f:
        data = json.load(f)

    trades = []
    for item in data if isinstance(data, list) else data.get("trades", []):
        timestamp = parse_relative_time(item.get("timestamp", ""))
        if not timestamp:
            try:
                timestamp = datetime.fromisoformat(item.get("timestamp", ""))
            except:
                timestamp = datetime.now(timezone.utc)

        trades.append(Trade(
            timestamp=timestamp,
            trade_type=item.get("type", "Unknown"),
            market=item.get("market", "Unknown"),
            amount=parse_money(str(item.get("amount", "0"))),
            outcome=item.get("outcome"),
            resolved=item.get("resolved", False),
            won=item.get("won"),
        ))

    return trades


def main():
    parser = argparse.ArgumentParser(description="Polymarket Live Scraper")
    parser.add_argument("--top-traders", action="store_true", help="Scrape leaderboard")
    parser.add_argument("--trader", type=str, help="Scrape specific trader")
    parser.add_argument("--find-insiders", action="store_true", help="Analyze for insider patterns")
    parser.add_argument("--load-file", type=str, help="Load trades from JSON file")
    parser.add_argument("--limit", type=int, default=50, help="Max traders to analyze")
    parser.add_argument("--output", type=str, help="Output file path")

    args = parser.parse_args()

    scraper = PolymarketScraper()

    try:
        if args.load_file:
            # Load from file for testing
            trades = load_trades_from_json(args.load_file)
            logger.info(f"Loaded {len(trades)} trades from {args.load_file}")

            # Analyze
            category_conc = calculate_category_concentration(trades)
            print("\nCategory Concentration:")
            for cat, pct in sorted(category_conc.items(), key=lambda x: -x[1]):
                print(f"  {cat}: {pct:.1%}")

        elif args.top_traders:
            traders = scraper.scrape_leaderboard(args.limit)
            print(f"\nFound {len(traders)} traders")

        elif args.trader:
            profile = scraper.get_trader_profile(args.trader)
            if profile:
                is_insider, reasons = is_potential_insider(profile)
                print(f"\nTrader: {profile.username}")
                print(f"Profit/Loss: ${profile.profit_loss:,.2f}")
                print(f"Win Rate: {profile.win_rate:.1%}")
                print(f"Volume: ${profile.volume:,.2f}")

                if is_insider:
                    print("\n⚠️  POTENTIAL INSIDER PATTERNS:")
                    for reason in reasons:
                        print(f"  - {reason}")

        elif args.find_insiders:
            logger.info("Scanning for potential insiders...")
            traders = scraper.scrape_leaderboard(args.limit)

            insiders = []
            for trader in traders:
                profile = scraper.get_trader_profile(trader.get("address", ""))
                if profile:
                    is_insider, reasons = is_potential_insider(profile)
                    if is_insider:
                        insiders.append((profile, reasons))

            print(f"\n Found {len(insiders)} potential insiders:")
            for profile, reasons in insiders:
                print(f"\n{profile.username}:")
                for reason in reasons:
                    print(f"  - {reason}")

        else:
            parser.print_help()

    finally:
        scraper.close()


if __name__ == "__main__":
    main()
