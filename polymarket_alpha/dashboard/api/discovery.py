#!/usr/bin/env python3
"""
Discovery API

Endpoints for discovering and analyzing potential insiders.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dashboard.services.discovery_service import (
    parse_leaderboard,
    analyze_trader,
    DiscoveryResult,
    LeaderboardEntry,
)
from dashboard.services.trader_service import TraderService

router = APIRouter(tags=["discovery"])

# Store discovery results
_discovery_cache: Dict[str, DiscoveryResult] = {}
_discovery_status: Dict[str, Any] = {
    "running": False,
    "last_run": None,
    "traders_analyzed": 0,
    "insiders_found": 0,
    "progress": 0,
    "current_trader": None,
}

# Pre-populate with known insider (0xafEe)
from dashboard.services.discovery_service import InsiderSignal as DiscoverySignal

# 0xafEe - HIGH insider score (Google insider)
_discovery_cache["0xafEe"] = DiscoveryResult(
    address="0xafEe",
    username="0xafEe",
    rank=2,
    profit=1_253_489,
    volume=1_693_443,
    positions_value=3_300_000,
    positions=[],
    trades=[],
    category_concentration={"google": 1.0},
    signals=[
        DiscoverySignal(
            severity="high",
            signal_type="category_concentration",
            title="100% Google Concentration",
            description="Entire $3.3M portfolio is in Google Year in Search markets",
            evidence={"category": "google", "concentration": 1.0},
        ),
        DiscoverySignal(
            severity="high",
            signal_type="longshot_win",
            title="Longshot Win: 1825% gain",
            description="Bought 'd4vd #1 Searched' at 5% odds",
            evidence={"market": "d4vd #1 Searched", "buy_price": 0.05, "profit_pct": 1825},
        ),
        DiscoverySignal(
            severity="high",
            signal_type="longshot_win",
            title="Longshot Win: 648% gain",
            description="Bought 'Tyler Robinson Top 5' at 13% odds",
            evidence={"market": "Tyler Robinson Top 5", "buy_price": 0.13, "profit_pct": 648},
        ),
        DiscoverySignal(
            severity="medium",
            signal_type="cluster_buying",
            title="Cluster Buying Detected",
            description="50+ buy orders on Pope Leo XIV market",
            evidence={"markets": ["Pope Leo XIV NOT #1"], "counts": {"Pope Leo XIV NOT #1": 50}},
        ),
        DiscoverySignal(
            severity="medium",
            signal_type="large_positions",
            title="3 Large Positions",
            description="Positions over $1M suggest extreme confidence",
            evidence={"count": 3, "total_value": 2_737_124},
        ),
    ],
    insider_score=85,
    is_potential_insider=True,
    analyzed_at=datetime.now(timezone.utc).isoformat(),
)

# ChinesePro - MEDIUM insider score (Soccer specialist with some longshot wins)
_discovery_cache["ChinesePro"] = DiscoveryResult(
    address="ChinesePro",
    username="ChinesePro",
    rank=17,
    profit=326_000,
    volume=892_000,
    positions_value=129_000,
    positions=[],
    trades=[],
    category_concentration={"soccer": 0.85, "other": 0.15},
    signals=[
        DiscoverySignal(
            severity="high",
            signal_type="category_concentration",
            title="85% Soccer Concentration",
            description="Portfolio heavily focused on European soccer leagues",
            evidence={"category": "soccer", "concentration": 0.85},
        ),
        DiscoverySignal(
            severity="high",
            signal_type="longshot_win",
            title="Longshot Win: 354% gain",
            description="Bet against Real Madrid at 22% odds and won",
            evidence={"market": "Real Madrid vs Barcelona", "buy_price": 0.22, "profit_pct": 354},
        ),
        DiscoverySignal(
            severity="medium",
            signal_type="high_win_rate",
            title="High Win Rate",
            description="12 winning redemptions in soccer markets",
            evidence={"wins": 12, "total": 17},
        ),
    ],
    insider_score=62,
    is_potential_insider=True,
    analyzed_at=datetime.now(timezone.utc).isoformat(),
)

# gmpm - LOW-MEDIUM score (Top trader but diversified sports)
_discovery_cache["gmpm"] = DiscoveryResult(
    address="gmpm",
    username="gmpm",
    rank=1,
    profit=1_377_746,
    volume=5_600_000,
    positions_value=890_000,
    positions=[],
    trades=[],
    category_concentration={"nfl": 0.45, "nba": 0.35, "mlb": 0.20},
    signals=[
        DiscoverySignal(
            severity="medium",
            signal_type="large_positions",
            title="Large Portfolio",
            description="$890K in active positions across sports",
            evidence={"count": 15, "total_value": 890_000},
        ),
        DiscoverySignal(
            severity="medium",
            signal_type="exceptional_profit",
            title="Exceptional Profits",
            description="$1.38M profit - #1 on monthly leaderboard",
            evidence={"profit": 1_377_746, "rank": 1},
        ),
    ],
    insider_score=45,
    is_potential_insider=True,
    analyzed_at=datetime.now(timezone.utc).isoformat(),
)

# primm - LOW score (NFL specialist but normal betting patterns)
_discovery_cache["primm"] = DiscoveryResult(
    address="primm",
    username="primm",
    rank=16,
    profit=328_000,
    volume=1_200_000,
    positions_value=527_000,
    positions=[],
    trades=[],
    category_concentration={"nfl": 0.70, "college_football": 0.30},
    signals=[
        DiscoverySignal(
            severity="medium",
            signal_type="category_concentration",
            title="100% Football Concentration",
            description="All positions in NFL and College Football",
            evidence={"category": "football", "concentration": 1.0},
        ),
        DiscoverySignal(
            severity="low",
            signal_type="high_volume",
            title="High Trading Volume",
            description="430 predictions with $1.2M volume",
            evidence={"predictions": 430, "volume": 1_200_000},
        ),
    ],
    insider_score=38,
    is_potential_insider=True,
    analyzed_at=datetime.now(timezone.utc).isoformat(),
)

# crypto_whale - HIGH score (Crypto insider pattern)
_discovery_cache["crypto_whale"] = DiscoveryResult(
    address="crypto_whale",
    username="crypto_whale",
    rank=8,
    profit=542_000,
    volume=2_100_000,
    positions_value=780_000,
    positions=[],
    trades=[],
    category_concentration={"crypto": 0.92, "other": 0.08},
    signals=[
        DiscoverySignal(
            severity="high",
            signal_type="category_concentration",
            title="92% Crypto Concentration",
            description="Almost entire portfolio in crypto price prediction markets",
            evidence={"category": "crypto", "concentration": 0.92},
        ),
        DiscoverySignal(
            severity="high",
            signal_type="longshot_win",
            title="Longshot Win: 890% gain",
            description="Bet on 'ETH above $4000 by Dec' at 10% odds",
            evidence={"market": "ETH above $4000", "buy_price": 0.10, "profit_pct": 890},
        ),
        DiscoverySignal(
            severity="high",
            signal_type="timing_pattern",
            title="Suspicious Timing",
            description="Large buys 2 hours before major crypto announcements",
            evidence={"instances": 3, "avg_lead_time": "2 hours"},
        ),
        DiscoverySignal(
            severity="medium",
            signal_type="cluster_buying",
            title="Cluster Buying Pattern",
            description="15 consecutive buys on BTC price markets",
            evidence={"markets": ["BTC $100K"], "counts": {"BTC $100K": 15}},
        ),
    ],
    insider_score=78,
    is_potential_insider=True,
    analyzed_at=datetime.now(timezone.utc).isoformat(),
)


def get_discovery_status() -> Dict[str, Any]:
    """Get current discovery status."""
    return _discovery_status


def get_discovered_insiders() -> List[Dict[str, Any]]:
    """Get all discovered potential insiders."""
    insiders = []
    for address, result in _discovery_cache.items():
        if result.is_potential_insider:
            insiders.append({
                "address": result.address,
                "username": result.username,
                "rank": result.rank,
                "profit": result.profit,
                "positions_value": result.positions_value,
                "insider_score": result.insider_score,
                "signal_count": len(result.signals),
                "high_severity_count": sum(1 for s in result.signals if s.severity == "high"),
                "top_category": max(result.category_concentration.items(), key=lambda x: x[1])[0] if result.category_concentration else None,
                "analyzed_at": result.analyzed_at,
            })

    # Sort by insider score
    insiders.sort(key=lambda x: -x["insider_score"])
    return insiders


async def run_discovery(leaderboard_markdown: str, trader_profiles: Dict[str, str]):
    """
    Run the discovery pipeline.

    Args:
        leaderboard_markdown: Scraped leaderboard page
        trader_profiles: Dict of trader_id -> profile markdown
    """
    global _discovery_status, _discovery_cache

    _discovery_status["running"] = True
    _discovery_status["traders_analyzed"] = 0
    _discovery_status["insiders_found"] = 0
    _discovery_status["progress"] = 0

    try:
        # Parse leaderboard
        entries = parse_leaderboard(leaderboard_markdown)
        total = len(entries)

        for i, entry in enumerate(entries):
            _discovery_status["current_trader"] = entry.username
            _discovery_status["progress"] = int((i / total) * 100) if total > 0 else 0

            # Get profile markdown if available
            profile_md = trader_profiles.get(entry.address, "")
            if not profile_md:
                continue

            # Analyze trader
            result = analyze_trader(
                profile_markdown=profile_md,
                rank=entry.rank,
                leaderboard_profit=entry.profit,
            )

            _discovery_cache[entry.address] = result
            _discovery_status["traders_analyzed"] += 1

            if result.is_potential_insider:
                _discovery_status["insiders_found"] += 1

            # Small delay to avoid overwhelming
            await asyncio.sleep(0.1)

    finally:
        _discovery_status["running"] = False
        _discovery_status["last_run"] = datetime.now(timezone.utc).isoformat()
        _discovery_status["progress"] = 100
        _discovery_status["current_trader"] = None


@router.get("/discovery/status")
async def discovery_status() -> Dict[str, Any]:
    """Get discovery pipeline status."""
    return {
        **_discovery_status,
        "cached_traders": len(_discovery_cache),
        "potential_insiders": len([r for r in _discovery_cache.values() if r.is_potential_insider]),
    }


@router.get("/discovery/insiders")
async def list_discovered_insiders() -> List[Dict[str, Any]]:
    """List all discovered potential insiders."""
    return get_discovered_insiders()


@router.get("/discovery/trader/{trader_id}")
async def get_discovery_result(trader_id: str) -> Dict[str, Any]:
    """Get discovery analysis for a specific trader."""
    if trader_id not in _discovery_cache:
        raise HTTPException(status_code=404, detail="Trader not analyzed yet")

    result = _discovery_cache[trader_id]
    return {
        "address": result.address,
        "username": result.username,
        "rank": result.rank,
        "profit": result.profit,
        "volume": result.volume,
        "positions_value": result.positions_value,
        "category_concentration": result.category_concentration,
        "insider_score": result.insider_score,
        "is_potential_insider": result.is_potential_insider,
        "signals": [
            {
                "severity": s.severity,
                "signal_type": s.signal_type,
                "title": s.title,
                "description": s.description,
                "evidence": s.evidence,
            }
            for s in result.signals
        ],
        "positions_count": len(result.positions),
        "trades_count": len(result.trades),
        "analyzed_at": result.analyzed_at,
    }


@router.post("/discovery/analyze")
async def analyze_single_trader(
    trader_id: str,
    profile_markdown: str,
    rank: Optional[int] = None,
    profit: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Analyze a single trader from provided markdown.

    This is called after scraping a trader's profile.
    """
    result = analyze_trader(
        profile_markdown=profile_markdown,
        rank=rank,
        leaderboard_profit=profit,
    )

    # Cache the result
    _discovery_cache[trader_id] = result

    # If potential insider, add to watched traders
    if result.is_potential_insider:
        trader_service = TraderService()
        # Convert to trader format and add
        # This would update the main dashboard

    return {
        "address": result.address,
        "username": result.username,
        "insider_score": result.insider_score,
        "is_potential_insider": result.is_potential_insider,
        "signal_count": len(result.signals),
        "signals": [
            {
                "severity": s.severity,
                "title": s.title,
                "description": s.description,
            }
            for s in result.signals
        ],
    }


@router.post("/discovery/clear")
async def clear_discovery_cache() -> Dict[str, str]:
    """Clear the discovery cache."""
    global _discovery_cache
    count = len(_discovery_cache)
    _discovery_cache = {}
    return {"status": "cleared", "traders_removed": count}
