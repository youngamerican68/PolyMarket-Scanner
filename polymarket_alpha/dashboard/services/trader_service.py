#!/usr/bin/env python3
"""
Trader Service

Handles trader data retrieval, caching, and insider analysis.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


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
    result: str = ""  # Won, Lost, Active
    categories: List[str] = field(default_factory=list)


@dataclass
class Trade:
    """A single trade/activity."""
    timestamp: str
    trade_type: str  # Buy, Sell, Redeem
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
    title: str
    description: str
    category: Optional[str] = None


@dataclass
class Trader:
    """Complete trader profile."""
    address: str
    username: str
    joined: str
    views: str
    positions_value: float
    biggest_win: float
    predictions: int
    profit_1w: float
    profit_1m: float
    rank_monthly: Optional[int]
    positions: List[Position]
    recent_trades: List[Trade]
    category_concentration: Dict[str, float]
    insider_signals: List[InsiderSignal]
    last_updated: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "address": self.address,
            "username": self.username,
            "joined": self.joined,
            "views": self.views,
            "positions_value": self.positions_value,
            "biggest_win": self.biggest_win,
            "predictions": self.predictions,
            "profit_1w": self.profit_1w,
            "profit_1m": self.profit_1m,
            "rank_monthly": self.rank_monthly,
            "positions": [asdict(p) for p in self.positions],
            "recent_trades": [asdict(t) for t in self.recent_trades],
            "category_concentration": self.category_concentration,
            "insider_signals": [asdict(s) for s in self.insider_signals],
            "last_updated": self.last_updated,
        }


@dataclass
class Alert:
    """An alert for copy-trading."""
    id: str
    timestamp: str
    trader_id: str
    trader_name: str
    alert_type: str  # new_position, large_trade, pattern_detected
    severity: str  # high, medium, low
    title: str
    description: str
    market: Optional[str] = None
    value: Optional[float] = None


class TraderService:
    """Service for managing trader data and analysis."""

    def __init__(self):
        self.data_dir = Path(__file__).parent.parent.parent / "data"
        self.output_dir = Path(__file__).parent.parent.parent / "output"
        self._cache: Dict[str, Trader] = {}
        self._load_cached_data()

    def _load_cached_data(self):
        """Load any cached trader data from files."""
        # Load from output directory (previous scrapes)
        for json_file in self.output_dir.glob("*_data.json"):
            try:
                with open(json_file) as f:
                    data = json.load(f)
                    if "address" in data:
                        trader = self._parse_trader_data(data)
                        self._cache[trader.address] = trader
            except Exception:
                pass

        # Load the known traders
        self._load_0xafee_data()
        self._load_sample_traders()

    def _load_sample_traders(self):
        """Load sample traders for demo/testing."""
        # crypto_whale - HIGH score (Crypto insider pattern)
        self._cache["crypto_whale"] = Trader(
            address="crypto_whale",
            username="crypto_whale",
            joined="Mar 2024",
            views="45.2k",
            positions_value=780_000,
            biggest_win=156_000,
            predictions=67,
            profit_1w=89_000,
            profit_1m=542_000,
            rank_monthly=8,
            positions=[
                Position(
                    market="ETH above $4000 by December",
                    market_url="https://polymarket.com/event/eth-price",
                    outcome="Yes",
                    shares=250_000,
                    avg_price=0.10,
                    current_price=1.0,
                    value=250_000,
                    profit_loss=225_000,
                    profit_pct=890,
                    result="Won",
                    categories=["crypto"],
                ),
                Position(
                    market="BTC to hit $100K",
                    market_url="https://polymarket.com/event/btc-price",
                    outcome="Yes",
                    shares=320_000,
                    avg_price=0.45,
                    current_price=0.92,
                    value=294_400,
                    profit_loss=150_400,
                    profit_pct=104,
                    result="Active",
                    categories=["crypto"],
                ),
                Position(
                    market="SOL above $300 by Jan",
                    market_url="https://polymarket.com/event/sol-price",
                    outcome="Yes",
                    shares=180_000,
                    avg_price=0.22,
                    current_price=0.65,
                    value=117_000,
                    profit_loss=77_400,
                    profit_pct=195,
                    result="Active",
                    categories=["crypto"],
                ),
            ],
            recent_trades=[
                Trade(
                    timestamp="1 day ago",
                    trade_type="Buy",
                    market="BTC to hit $100K",
                    outcome="Yes",
                    shares=50_000,
                    amount=23_000,
                    price=0.46,
                    categories=["crypto"],
                ),
                Trade(
                    timestamp="3 days ago",
                    trade_type="Redeem",
                    market="ETH above $4000 by December",
                    outcome="Yes",
                    shares=250_000,
                    amount=250_000,
                    price=1.0,
                    categories=["crypto"],
                ),
            ],
            category_concentration={"crypto": 0.92, "other": 0.08},
            insider_signals=[
                InsiderSignal(
                    severity="high",
                    title="92% Crypto Concentration",
                    description="Almost entire portfolio in crypto price prediction markets",
                    category="crypto",
                ),
                InsiderSignal(
                    severity="high",
                    title="Longshot Win: 890% gain",
                    description="Bet on 'ETH above $4000 by Dec' at 10% odds",
                    category="crypto",
                ),
                InsiderSignal(
                    severity="high",
                    title="Suspicious Timing",
                    description="Large buys 2 hours before major crypto announcements",
                    category="crypto",
                ),
                InsiderSignal(
                    severity="medium",
                    title="Cluster Buying Pattern",
                    description="15 consecutive buys on BTC price markets",
                    category="crypto",
                ),
            ],
            last_updated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        )

        # ChinesePro - MEDIUM score (Soccer specialist)
        self._cache["ChinesePro"] = Trader(
            address="ChinesePro",
            username="ChinesePro",
            joined="Oct 2024",
            views="12.8k",
            positions_value=129_000,
            biggest_win=74_000,
            predictions=177,
            profit_1w=45_000,
            profit_1m=326_000,
            rank_monthly=17,
            positions=[
                Position(
                    market="Real Madrid vs Barcelona - El Clasico",
                    market_url="https://polymarket.com/event/la-liga",
                    outcome="Barcelona Win",
                    shares=85_000,
                    avg_price=0.22,
                    current_price=1.0,
                    value=85_000,
                    profit_loss=66_300,
                    profit_pct=354,
                    result="Won",
                    categories=["soccer"],
                ),
                Position(
                    market="Liverpool vs Man City - Premier League",
                    market_url="https://polymarket.com/event/premier-league",
                    outcome="Liverpool Win",
                    shares=44_000,
                    avg_price=0.35,
                    current_price=0.62,
                    value=27_280,
                    profit_loss=11_880,
                    profit_pct=77,
                    result="Active",
                    categories=["soccer"],
                ),
            ],
            recent_trades=[
                Trade(
                    timestamp="5 hours ago",
                    trade_type="Buy",
                    market="Bayern vs Dortmund",
                    outcome="Dortmund",
                    shares=15_000,
                    amount=4_500,
                    price=0.30,
                    categories=["soccer"],
                ),
            ],
            category_concentration={"soccer": 0.85, "other": 0.15},
            insider_signals=[
                InsiderSignal(
                    severity="high",
                    title="85% Soccer Concentration",
                    description="Portfolio heavily focused on European soccer leagues",
                    category="soccer",
                ),
                InsiderSignal(
                    severity="high",
                    title="Longshot Win: 354% gain",
                    description="Bet against Real Madrid at 22% odds and won",
                    category="soccer",
                ),
                InsiderSignal(
                    severity="medium",
                    title="High Win Rate",
                    description="12 winning redemptions in soccer markets",
                    category="soccer",
                ),
            ],
            last_updated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        )

        # gmpm - LOW-MEDIUM score (Top trader, diversified sports)
        self._cache["gmpm"] = Trader(
            address="gmpm",
            username="gmpm",
            joined="Jan 2024",
            views="156k",
            positions_value=890_000,
            biggest_win=245_000,
            predictions=892,
            profit_1w=312_000,
            profit_1m=1_377_746,
            rank_monthly=1,
            positions=[
                Position(
                    market="Chiefs vs Bills - AFC Championship",
                    market_url="https://polymarket.com/event/nfl",
                    outcome="Chiefs",
                    shares=180_000,
                    avg_price=0.52,
                    current_price=0.68,
                    value=122_400,
                    profit_loss=28_800,
                    profit_pct=31,
                    result="Active",
                    categories=["nfl"],
                ),
                Position(
                    market="Lakers vs Celtics - NBA Finals",
                    market_url="https://polymarket.com/event/nba",
                    outcome="Celtics",
                    shares=220_000,
                    avg_price=0.48,
                    current_price=0.55,
                    value=121_000,
                    profit_loss=15_400,
                    profit_pct=15,
                    result="Active",
                    categories=["nba"],
                ),
            ],
            recent_trades=[
                Trade(
                    timestamp="2 hours ago",
                    trade_type="Buy",
                    market="Eagles vs Cowboys",
                    outcome="Eagles",
                    shares=45_000,
                    amount=24_750,
                    price=0.55,
                    categories=["nfl"],
                ),
            ],
            category_concentration={"nfl": 0.45, "nba": 0.35, "mlb": 0.20},
            insider_signals=[
                InsiderSignal(
                    severity="medium",
                    title="Large Portfolio",
                    description="$890K in active positions across sports",
                    category=None,
                ),
                InsiderSignal(
                    severity="medium",
                    title="Exceptional Profits",
                    description="$1.38M profit - #1 on monthly leaderboard",
                    category=None,
                ),
            ],
            last_updated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        )

        # primm - LOW score (NFL specialist, normal patterns)
        self._cache["primm"] = Trader(
            address="primm",
            username="primm",
            joined="Aug 2025",
            views="8.3k",
            positions_value=527_000,
            biggest_win=249_000,
            predictions=430,
            profit_1w=78_000,
            profit_1m=328_000,
            rank_monthly=16,
            positions=[
                Position(
                    market="Steelers vs Ravens - Week 16",
                    market_url="https://polymarket.com/event/nfl",
                    outcome="Steelers",
                    shares=95_000,
                    avg_price=0.48,
                    current_price=0.52,
                    value=49_400,
                    profit_loss=3_800,
                    profit_pct=8,
                    result="Active",
                    categories=["nfl"],
                ),
                Position(
                    market="Georgia vs Alabama - CFP",
                    market_url="https://polymarket.com/event/college-football",
                    outcome="Georgia",
                    shares=120_000,
                    avg_price=0.55,
                    current_price=0.61,
                    value=73_200,
                    profit_loss=7_200,
                    profit_pct=11,
                    result="Active",
                    categories=["college_football"],
                ),
            ],
            recent_trades=[
                Trade(
                    timestamp="6 hours ago",
                    trade_type="Buy",
                    market="49ers vs Seahawks",
                    outcome="49ers",
                    shares=30_000,
                    amount=16_200,
                    price=0.54,
                    categories=["nfl"],
                ),
            ],
            category_concentration={"nfl": 0.70, "college_football": 0.30},
            insider_signals=[
                InsiderSignal(
                    severity="medium",
                    title="100% Football Concentration",
                    description="All positions in NFL and College Football",
                    category="nfl",
                ),
                InsiderSignal(
                    severity="low",
                    title="High Trading Volume",
                    description="430 predictions with $1.2M volume",
                    category=None,
                ),
            ],
            last_updated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        )

    def _load_0xafee_data(self):
        """Load the known 0xafEe trader data."""
        # This is the data we scraped and analyzed
        trader = Trader(
            address="0xafEe",
            username="0xafEe",
            joined="May 2024",
            views="71.6k",
            positions_value=3_300_000,
            biggest_win=87_800,
            predictions=92,
            profit_1w=1_250_088,
            profit_1m=1_253_489,
            rank_monthly=1,
            positions=[
                Position(
                    market="Bianca Censori NOT #1 searched on Google",
                    market_url="https://polymarket.com/event/google-search",
                    outcome="No",
                    shares=1_103_573,
                    avg_price=0.85,
                    current_price=1.0,
                    value=1_103_573,
                    profit_loss=165_943,
                    profit_pct=17.7,
                    result="Won",
                    categories=["google"],
                ),
                Position(
                    market="Pope Leo XIV NOT #1 searched on Google",
                    market_url="https://polymarket.com/event/google-search",
                    outcome="No",
                    shares=1_069_317,
                    avg_price=0.56,
                    current_price=1.0,
                    value=1_069_317,
                    profit_loss=470_619,
                    profit_pct=79.7,
                    result="Won",
                    categories=["google"],
                ),
                Position(
                    market="Donald Trump NOT #1 searched on Google",
                    market_url="https://polymarket.com/event/google-search",
                    outcome="No",
                    shares=564_234,
                    avg_price=0.90,
                    current_price=1.0,
                    value=564_234,
                    profit_loss=56_423,
                    profit_pct=10.8,
                    result="Won",
                    categories=["google"],
                ),
                Position(
                    market="d4vd IS #1 searched person on Google",
                    market_url="https://polymarket.com/event/google-search",
                    outcome="Yes",
                    shares=205_108,
                    avg_price=0.05,
                    current_price=1.0,
                    value=205_006,
                    profit_loss=194_853,
                    profit_pct=1825,
                    result="Won",
                    categories=["google"],
                ),
                Position(
                    market="Kendrick Lamar in Top 5 searched",
                    market_url="https://polymarket.com/event/google-search",
                    outcome="Yes",
                    shares=73_642,
                    avg_price=0.38,
                    current_price=1.0,
                    value=73_642,
                    profit_loss=45_618,
                    profit_pct=164,
                    result="Won",
                    categories=["google"],
                ),
                Position(
                    market="Gemini 3.0 Flash NOT released by Dec 15",
                    market_url="https://polymarket.com/event/gemini",
                    outcome="No",
                    shares=30_000,
                    avg_price=0.90,
                    current_price=0.97,
                    value=28_995,
                    profit_loss=1_995,
                    profit_pct=7.4,
                    result="Active",
                    categories=["google"],
                ),
                Position(
                    market="Tyler Robinson in Top 5 searched",
                    market_url="https://polymarket.com/event/google-search",
                    outcome="Yes",
                    shares=7_323,
                    avg_price=0.13,
                    current_price=1.0,
                    value=7_323,
                    profit_loss=6_371,
                    profit_pct=648,
                    result="Won",
                    categories=["google"],
                ),
            ],
            recent_trades=[
                Trade(
                    timestamp="2 days ago",
                    trade_type="Redeem",
                    market="Pope Leo XIV in Top 5 searched",
                    outcome="Yes",
                    shares=195_843,
                    amount=195_843,
                    price=1.0,
                    categories=["google"],
                ),
                Trade(
                    timestamp="2 days ago",
                    trade_type="Redeem",
                    market="Donald Trump in Top 5 searched",
                    outcome="Yes",
                    shares=259_408,
                    amount=259_408,
                    price=1.0,
                    categories=["google"],
                ),
                Trade(
                    timestamp="3 days ago",
                    trade_type="Buy",
                    market="Pope Leo XIV NOT #1 searched",
                    outcome="No",
                    shares=50_000,
                    amount=27_000,
                    price=0.54,
                    categories=["google"],
                ),
            ],
            category_concentration={"google": 1.0},
            insider_signals=[
                InsiderSignal(
                    severity="high",
                    title="100% Google Concentration",
                    description="Entire $3.3M portfolio is in Google Year in Search markets",
                    category="google",
                ),
                InsiderSignal(
                    severity="high",
                    title="Impossible Longshot Win",
                    description="d4vd bought at 5% odds, now 100% - 1,825% gain on unknown artist",
                    category="google",
                ),
                InsiderSignal(
                    severity="high",
                    title="Cluster Buying Pattern",
                    description="50+ buy orders on single markets in days",
                    category=None,
                ),
                InsiderSignal(
                    severity="medium",
                    title="Large Position Sizes",
                    description="$1M+ positions suggest extreme confidence or certainty",
                    category=None,
                ),
                InsiderSignal(
                    severity="medium",
                    title="Tyler Robinson Knowledge",
                    description="Bought at 13% odds - obscure pick that hit",
                    category="google",
                ),
            ],
            last_updated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        )
        self._cache["0xafEe"] = trader

    def _parse_trader_data(self, data: Dict[str, Any]) -> Trader:
        """Parse trader data from JSON."""
        positions = []
        for p in data.get("positions", []):
            positions.append(Position(**p))

        trades = []
        for t in data.get("recent_trades", []):
            trades.append(Trade(**t))

        signals = []
        for s in data.get("insider_signals", []):
            signals.append(InsiderSignal(**s))

        return Trader(
            address=data.get("address", ""),
            username=data.get("username", ""),
            joined=data.get("joined", ""),
            views=data.get("views", ""),
            positions_value=data.get("positions_value", 0),
            biggest_win=data.get("biggest_win", 0),
            predictions=data.get("predictions", 0),
            profit_1w=data.get("profit_1w", 0),
            profit_1m=data.get("profit_1m", 0),
            rank_monthly=data.get("rank_monthly"),
            positions=positions,
            recent_trades=trades,
            category_concentration=data.get("category_concentration", {}),
            insider_signals=signals,
            last_updated=data.get("last_updated", ""),
        )

    def get_watched_traders(self) -> List[Dict[str, Any]]:
        """Get list of watched traders with summary info."""
        traders = []

        for address, trader in self._cache.items():
            has_alerts = len(trader.insider_signals) > 0
            high_severity = any(s.severity == "high" for s in trader.insider_signals)

            traders.append({
                "address": trader.address,
                "username": trader.username,
                "positions_value": trader.positions_value,
                "profit_1w": trader.profit_1w,
                "profit_1m": trader.profit_1m,
                "rank_monthly": trader.rank_monthly,
                "predictions": trader.predictions,
                "has_alerts": has_alerts,
                "alert_count": len(trader.insider_signals),
                "high_severity": high_severity,
                "top_category": max(trader.category_concentration.items(), key=lambda x: x[1])[0] if trader.category_concentration else None,
                "category_pct": max(trader.category_concentration.values()) if trader.category_concentration else 0,
                "last_updated": trader.last_updated,
            })

        # Sort by alert severity, then profit
        traders.sort(key=lambda x: (-x["high_severity"], -x["alert_count"], -x["profit_1m"]))

        return traders

    def get_trader(self, trader_id: str) -> Optional[Trader]:
        """Get full trader profile by address."""
        # Try exact match
        if trader_id in self._cache:
            return self._cache[trader_id]

        # Try case-insensitive match
        for address, trader in self._cache.items():
            if address.lower() == trader_id.lower():
                return trader

        return None

    def get_recent_alerts(self, limit: int = 5) -> List[Alert]:
        """Get most recent alerts across all traders."""
        alerts = []

        for address, trader in self._cache.items():
            for signal in trader.insider_signals:
                alerts.append(Alert(
                    id=f"{address}-{signal.title[:20]}",
                    timestamp=trader.last_updated,
                    trader_id=address,
                    trader_name=trader.username,
                    alert_type="pattern_detected",
                    severity=signal.severity,
                    title=signal.title,
                    description=signal.description,
                ))

        # Sort by severity
        severity_order = {"high": 0, "medium": 1, "low": 2}
        alerts.sort(key=lambda x: severity_order.get(x.severity, 3))

        return alerts[:limit]

    def get_all_alerts(self) -> List[Alert]:
        """Get all alerts."""
        return self.get_recent_alerts(limit=100)

    def add_trader(self, address: str, data: Dict[str, Any]) -> Trader:
        """Add or update a trader in the cache."""
        trader = self._parse_trader_data(data)
        self._cache[address] = trader
        return trader

    def refresh_trader(self, trader_id: str) -> bool:
        """Mark trader for refresh (would trigger Firecrawl)."""
        # In a real implementation, this would queue a scrape job
        return trader_id in self._cache
