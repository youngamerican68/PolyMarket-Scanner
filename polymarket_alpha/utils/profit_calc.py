"""
Profit and metrics calculation functions for Polymarket wallet analysis.
These functions are primarily for local debugging; Claude will also compute metrics.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from .normalize import normalize_timestamp


def calculate_trade_pnl(trade: dict) -> float:
    """
    Calculate PnL for a single trade.

    For resolved trades:
    - If outcome matches position: payout - cost
    - If outcome doesn't match: -cost

    For unresolved trades:
    - Return 0 (position still open)

    Args:
        trade: Normalized trade dictionary

    Returns:
        PnL value in USD
    """
    trade_type = trade.get("type", "")
    amount_usd = float(trade.get("amount_usd", 0))
    payout_usd = float(trade.get("payout_usd", 0))
    resolved_outcome = trade.get("resolved_outcome")

    if trade_type == "Redeem":
        return payout_usd

    if trade_type == "Buy":
        if resolved_outcome is not None and resolved_outcome != "":
            return payout_usd - amount_usd
        else:
            return 0.0

    if trade_type == "Sell":
        return amount_usd

    return 0.0


def filter_trades_by_date_range(
    trades: List[dict],
    end_date: datetime,
    days_back: int = 7
) -> List[dict]:
    """
    Filter trades to those within a specific date range.

    Args:
        trades: List of normalized trade dictionaries
        end_date: End date of the range
        days_back: Number of days to look back

    Returns:
        Filtered list of trades
    """
    start_date = end_date - timedelta(days=days_back)

    filtered = []
    for trade in trades:
        timestamp_str = trade.get("timestamp", "")
        if not timestamp_str:
            continue

        trade_date = normalize_timestamp(timestamp_str)

        if start_date <= trade_date <= end_date:
            filtered.append(trade)

    return filtered


def calculate_profit_7d(trades: List[dict], as_of_date: datetime) -> float:
    """
    Calculate total profit over the last 7 days.

    Args:
        trades: List of normalized trade dictionaries
        as_of_date: Date to calculate from

    Returns:
        Total profit in USD
    """
    recent_trades = filter_trades_by_date_range(trades, as_of_date, days_back=7)

    total_profit = 0.0
    for trade in recent_trades:
        if trade.get("resolved_outcome") is not None:
            total_profit += calculate_trade_pnl(trade)

    return round(total_profit, 2)


def calculate_total_staked_7d(trades: List[dict], as_of_date: datetime) -> float:
    """
    Calculate total amount staked (cost basis) in the last 7 days.

    Args:
        trades: List of normalized trade dictionaries
        as_of_date: Date to calculate from

    Returns:
        Total staked amount in USD
    """
    recent_trades = filter_trades_by_date_range(trades, as_of_date, days_back=7)

    total_staked = 0.0
    for trade in recent_trades:
        if trade.get("type") == "Buy":
            total_staked += float(trade.get("amount_usd", 0))

    return total_staked


def calculate_roi(profit_7d: float, total_staked_7d: float) -> float:
    """
    Calculate ROI as profit / total staked.

    Args:
        profit_7d: Total profit in last 7 days
        total_staked_7d: Total staked in last 7 days

    Returns:
        ROI as decimal (e.g., 0.25 for 25%)
    """
    if total_staked_7d <= 0:
        return 0.0

    return round(profit_7d / total_staked_7d, 4)


def calculate_win_rate(trades: List[dict], as_of_date: datetime) -> float:
    """
    Calculate win rate for resolved markets in last 7 days.
    Win = payout > 0
    Loss = payout == 0

    Args:
        trades: List of normalized trade dictionaries
        as_of_date: Date to calculate from

    Returns:
        Win rate as decimal (0.0 to 1.0)
    """
    recent_trades = filter_trades_by_date_range(trades, as_of_date, days_back=7)

    resolved_trades = [
        t for t in recent_trades
        if t.get("resolved_outcome") is not None and t.get("type") == "Buy"
    ]

    if not resolved_trades:
        return 0.0

    wins = sum(1 for t in resolved_trades if float(t.get("payout_usd", 0)) > 0)

    return round(wins / len(resolved_trades), 4)


def calculate_consistency_score(
    win_rate: float,
    trade_count: int,
    profit_7d: float
) -> int:
    """
    Calculate a consistency score from 0-100 based on:
    - Win rate (40% weight)
    - Number of trades (30% weight) - more trades = more consistent
    - Profit stability (30% weight) - positive profit contributes

    Args:
        win_rate: Win rate as decimal (0.0 to 1.0)
        trade_count: Number of trades in the period
        profit_7d: Total profit in USD

    Returns:
        Consistency score from 0 to 100
    """
    win_rate_score = win_rate * 40

    if trade_count >= 20:
        trade_score = 30
    elif trade_count >= 10:
        trade_score = 25
    elif trade_count >= 5:
        trade_score = 15
    elif trade_count >= 3:
        trade_score = 10
    else:
        trade_score = 5

    if profit_7d >= 1000:
        profit_score = 30
    elif profit_7d >= 500:
        profit_score = 25
    elif profit_7d >= 100:
        profit_score = 20
    elif profit_7d > 0:
        profit_score = 15
    else:
        profit_score = 0

    total_score = win_rate_score + trade_score + profit_score

    return min(100, max(0, int(total_score)))


def determine_flags(
    profit_7d: float,
    consistency_score: int,
    win_rate: float,
    trade_count: int,
    thresholds: dict
) -> List[str]:
    """
    Determine flags based on wallet metrics.

    Flags:
    - HighProfit: profit_7d above threshold
    - HighConsistency: consistency_score >= 80 with enough trades
    - Emerging: Few trades but strong early performance
    - SuspiciouslyAccurate: Near-perfect win rate with sufficient sample

    Args:
        profit_7d: Total profit in last 7 days
        consistency_score: Calculated consistency score
        win_rate: Win rate as decimal
        trade_count: Number of trades
        thresholds: Dictionary of threshold values from config

    Returns:
        List of flag strings
    """
    flags = []

    high_profit_threshold = thresholds.get("high_profit_usd", 500.0)
    high_consistency_threshold = thresholds.get("high_consistency_score", 80)
    min_trades_emerging = thresholds.get("min_trades_for_emerging", 3)
    min_trades_suspicious = thresholds.get("min_trades_for_suspicious", 10)
    suspicious_win_rate = thresholds.get("suspicious_win_rate", 0.95)

    if profit_7d >= high_profit_threshold:
        flags.append("HighProfit")

    if consistency_score >= high_consistency_threshold and trade_count >= 5:
        flags.append("HighConsistency")

    if trade_count >= min_trades_emerging and trade_count < 10:
        if win_rate >= 0.7 and profit_7d > 0:
            flags.append("Emerging")

    if trade_count >= min_trades_suspicious and win_rate >= suspicious_win_rate:
        flags.append("SuspiciouslyAccurate")

    return flags


def calculate_wallet_metrics(
    trades: List[dict],
    as_of_date: datetime,
    thresholds: dict
) -> dict:
    """
    Calculate all metrics for a single wallet.

    Args:
        trades: List of normalized trade dictionaries
        as_of_date: Date to calculate from
        thresholds: Dictionary of threshold values from config

    Returns:
        Dictionary with all calculated metrics
    """
    recent_trades = filter_trades_by_date_range(trades, as_of_date, days_back=7)
    trade_count = len(recent_trades)

    profit_7d = calculate_profit_7d(trades, as_of_date)
    total_staked_7d = calculate_total_staked_7d(trades, as_of_date)
    roi = calculate_roi(profit_7d, total_staked_7d)
    win_rate = calculate_win_rate(trades, as_of_date)
    consistency_score = calculate_consistency_score(win_rate, trade_count, profit_7d)
    flags = determine_flags(
        profit_7d, consistency_score, win_rate, trade_count, thresholds
    )

    return {
        "profit_7d": profit_7d,
        "total_staked_7d": total_staked_7d,
        "roi": roi,
        "win_rate": win_rate,
        "consistency_score": consistency_score,
        "trade_count_7d": trade_count,
        "flags": flags
    }


if __name__ == "__main__":
    sample_trades = [
        {
            "type": "Buy",
            "market_name": "Will BTC be above 100k by 2025?",
            "amount_usd": 150.0,
            "timestamp": "2025-01-02T13:45:00Z",
            "resolved_outcome": "Yes",
            "payout_usd": 220.0
        },
        {
            "type": "Buy",
            "market_name": "Will ETH flip BTC?",
            "amount_usd": 100.0,
            "timestamp": "2025-01-01T10:00:00Z",
            "resolved_outcome": "No",
            "payout_usd": 0.0
        },
        {
            "type": "Buy",
            "market_name": "Trump wins 2024?",
            "amount_usd": 200.0,
            "timestamp": "2024-12-28T08:00:00Z",
            "resolved_outcome": "Yes",
            "payout_usd": 350.0
        },
        {
            "type": "Sell",
            "market_name": "Market pullback in Jan?",
            "amount_usd": 50.0,
            "timestamp": "2025-01-02T09:00:00Z",
            "resolved_outcome": None,
            "payout_usd": 0.0
        },
    ]

    as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)

    thresholds = {
        "high_profit_usd": 500.0,
        "high_consistency_score": 80,
        "min_trades_for_emerging": 3,
        "min_trades_for_suspicious": 10,
        "suspicious_win_rate": 0.95
    }

    print("Testing profit calculations:")
    print(f"  Trades count: {len(sample_trades)}")

    metrics = calculate_wallet_metrics(sample_trades, as_of, thresholds)
    print(f"\nCalculated metrics:")
    for key, value in metrics.items():
        print(f"  {key}: {value}")
