#!/usr/bin/env python3
"""
Traders API

REST endpoints for trader data.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dashboard.services.trader_service import TraderService

router = APIRouter(tags=["traders"])
trader_service = TraderService()


@router.get("/traders")
async def list_traders() -> List[Dict[str, Any]]:
    """List all watched traders."""
    return trader_service.get_watched_traders()


@router.get("/traders/{trader_id}")
async def get_trader(trader_id: str) -> Dict[str, Any]:
    """Get full trader profile."""
    trader = trader_service.get_trader(trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    return trader.to_dict()


@router.get("/traders/{trader_id}/positions")
async def get_trader_positions(
    trader_id: str,
    status: Optional[str] = None,  # active, closed, all
    sort_by: Optional[str] = "value",  # value, profit_pct, market
) -> List[Dict[str, Any]]:
    """Get trader's positions with optional filtering."""
    trader = trader_service.get_trader(trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    positions = trader.positions

    # Filter by status
    if status == "active":
        positions = [p for p in positions if p.result == "Active"]
    elif status == "closed":
        positions = [p for p in positions if p.result in ["Won", "Lost"]]

    # Sort
    if sort_by == "value":
        positions.sort(key=lambda x: -x.value)
    elif sort_by == "profit_pct":
        positions.sort(key=lambda x: -x.profit_pct)
    elif sort_by == "market":
        positions.sort(key=lambda x: x.market)

    return [
        {
            "market": p.market,
            "outcome": p.outcome,
            "shares": p.shares,
            "avg_price": p.avg_price,
            "current_price": p.current_price,
            "value": p.value,
            "profit_loss": p.profit_loss,
            "profit_pct": p.profit_pct,
            "result": p.result,
            "categories": p.categories,
        }
        for p in positions
    ]


@router.get("/traders/{trader_id}/activity")
async def get_trader_activity(
    trader_id: str,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Get trader's recent activity."""
    trader = trader_service.get_trader(trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    return [
        {
            "timestamp": t.timestamp,
            "trade_type": t.trade_type,
            "market": t.market,
            "outcome": t.outcome,
            "shares": t.shares,
            "amount": t.amount,
            "price": t.price,
            "categories": t.categories,
        }
        for t in trader.recent_trades[:limit]
    ]


@router.get("/alerts")
async def list_alerts(limit: int = 20) -> List[Dict[str, Any]]:
    """List all alerts."""
    alerts = trader_service.get_recent_alerts(limit)
    return [
        {
            "id": a.id,
            "timestamp": a.timestamp,
            "trader_id": a.trader_id,
            "trader_name": a.trader_name,
            "alert_type": a.alert_type,
            "severity": a.severity,
            "title": a.title,
            "description": a.description,
        }
        for a in alerts
    ]


@router.post("/traders/{trader_id}/refresh")
async def refresh_trader(trader_id: str) -> Dict[str, Any]:
    """Trigger a refresh for a trader's data."""
    if trader_service.refresh_trader(trader_id):
        return {
            "status": "queued",
            "trader_id": trader_id,
            "message": f"Refresh queued for {trader_id}",
        }
    raise HTTPException(status_code=404, detail="Trader not found")
