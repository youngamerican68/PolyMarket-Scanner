"""Tests for profit calculation functions."""

from datetime import datetime, timezone

import pytest

from utils.profit_calc import (
    calculate_consistency_score,
    calculate_profit_7d,
    calculate_roi,
    calculate_total_staked_7d,
    calculate_trade_pnl,
    calculate_wallet_metrics,
    calculate_win_rate,
    determine_flags,
    filter_trades_by_date_range,
)


class TestCalculateTradePnl:
    """Tests for calculate_trade_pnl function."""

    def test_buy_trade_win(self) -> None:
        trade = {
            "type": "Buy",
            "amount_usd": 100.0,
            "payout_usd": 150.0,
            "resolved_outcome": "Yes",
        }
        assert calculate_trade_pnl(trade) == 50.0

    def test_buy_trade_loss(self) -> None:
        trade = {
            "type": "Buy",
            "amount_usd": 100.0,
            "payout_usd": 0.0,
            "resolved_outcome": "No",
        }
        assert calculate_trade_pnl(trade) == -100.0

    def test_buy_trade_unresolved(self) -> None:
        trade = {
            "type": "Buy",
            "amount_usd": 100.0,
            "payout_usd": 0.0,
            "resolved_outcome": None,
        }
        assert calculate_trade_pnl(trade) == 0.0

    def test_sell_trade(self) -> None:
        trade = {
            "type": "Sell",
            "amount_usd": 75.0,
            "payout_usd": 0.0,
            "resolved_outcome": None,
        }
        assert calculate_trade_pnl(trade) == 75.0

    def test_redeem_trade(self) -> None:
        trade = {
            "type": "Redeem",
            "amount_usd": 0.0,
            "payout_usd": 200.0,
            "resolved_outcome": "Yes",
        }
        assert calculate_trade_pnl(trade) == 200.0


class TestFilterTradesByDateRange:
    """Tests for filter_trades_by_date_range function."""

    @pytest.fixture
    def sample_trades(self) -> list[dict]:
        return [
            {"type": "Buy", "timestamp": "2025-01-01T10:00:00Z", "amount_usd": 100.0},
            {"type": "Buy", "timestamp": "2025-01-03T10:00:00Z", "amount_usd": 150.0},
            {"type": "Sell", "timestamp": "2025-01-05T10:00:00Z", "amount_usd": 75.0},
            {"type": "Buy", "timestamp": "2024-12-20T10:00:00Z", "amount_usd": 200.0},  # Outside range
        ]

    def test_filter_within_7_days(self, sample_trades: list[dict]) -> None:
        end_date = datetime(2025, 1, 5, tzinfo=timezone.utc)
        filtered = filter_trades_by_date_range(sample_trades, end_date, days_back=7)
        assert len(filtered) == 3

    def test_filter_empty_trades(self) -> None:
        end_date = datetime(2025, 1, 5, tzinfo=timezone.utc)
        filtered = filter_trades_by_date_range([], end_date)
        assert filtered == []

    def test_filter_custom_days_back(self, sample_trades: list[dict]) -> None:
        end_date = datetime(2025, 1, 5, tzinfo=timezone.utc)
        filtered = filter_trades_by_date_range(sample_trades, end_date, days_back=3)
        assert len(filtered) == 2


class TestCalculateProfit7d:
    """Tests for calculate_profit_7d function."""

    def test_profitable_trades(self) -> None:
        trades = [
            {
                "type": "Buy",
                "timestamp": "2025-01-02T10:00:00Z",
                "amount_usd": 100.0,
                "payout_usd": 150.0,
                "resolved_outcome": "Yes",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-03T10:00:00Z",
                "amount_usd": 100.0,
                "payout_usd": 120.0,
                "resolved_outcome": "Yes",
            },
        ]
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        profit = calculate_profit_7d(trades, as_of)
        assert profit == 70.0  # (150-100) + (120-100)

    def test_mixed_outcomes(self) -> None:
        trades = [
            {
                "type": "Buy",
                "timestamp": "2025-01-02T10:00:00Z",
                "amount_usd": 100.0,
                "payout_usd": 150.0,
                "resolved_outcome": "Yes",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-03T10:00:00Z",
                "amount_usd": 100.0,
                "payout_usd": 0.0,
                "resolved_outcome": "No",
            },
        ]
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        profit = calculate_profit_7d(trades, as_of)
        assert profit == -50.0  # 50 - 100

    def test_no_resolved_trades(self) -> None:
        trades = [
            {
                "type": "Buy",
                "timestamp": "2025-01-02T10:00:00Z",
                "amount_usd": 100.0,
                "payout_usd": 0.0,
                "resolved_outcome": None,
            },
        ]
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        profit = calculate_profit_7d(trades, as_of)
        assert profit == 0.0


class TestCalculateTotalStaked7d:
    """Tests for calculate_total_staked_7d function."""

    def test_total_staked(self) -> None:
        trades = [
            {"type": "Buy", "timestamp": "2025-01-02T10:00:00Z", "amount_usd": 100.0},
            {"type": "Buy", "timestamp": "2025-01-03T10:00:00Z", "amount_usd": 200.0},
            {"type": "Sell", "timestamp": "2025-01-03T10:00:00Z", "amount_usd": 50.0},
        ]
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        staked = calculate_total_staked_7d(trades, as_of)
        assert staked == 300.0  # Only Buy trades


class TestCalculateRoi:
    """Tests for calculate_roi function."""

    def test_positive_roi(self) -> None:
        roi = calculate_roi(100.0, 400.0)
        assert roi == 0.25

    def test_negative_roi(self) -> None:
        roi = calculate_roi(-50.0, 200.0)
        assert roi == -0.25

    def test_zero_staked(self) -> None:
        roi = calculate_roi(100.0, 0.0)
        assert roi == 0.0


class TestCalculateWinRate:
    """Tests for calculate_win_rate function."""

    def test_all_wins(self) -> None:
        trades = [
            {
                "type": "Buy",
                "timestamp": "2025-01-02T10:00:00Z",
                "payout_usd": 100.0,
                "resolved_outcome": "Yes",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-03T10:00:00Z",
                "payout_usd": 100.0,
                "resolved_outcome": "Yes",
            },
        ]
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        win_rate = calculate_win_rate(trades, as_of)
        assert win_rate == 1.0

    def test_mixed_wins_losses(self) -> None:
        trades = [
            {
                "type": "Buy",
                "timestamp": "2025-01-02T10:00:00Z",
                "payout_usd": 100.0,
                "resolved_outcome": "Yes",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-03T10:00:00Z",
                "payout_usd": 0.0,
                "resolved_outcome": "No",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-04T10:00:00Z",
                "payout_usd": 100.0,
                "resolved_outcome": "Yes",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-04T10:00:00Z",
                "payout_usd": 0.0,
                "resolved_outcome": "No",
            },
        ]
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        win_rate = calculate_win_rate(trades, as_of)
        assert win_rate == 0.5

    def test_no_resolved_trades(self) -> None:
        trades = [
            {
                "type": "Buy",
                "timestamp": "2025-01-02T10:00:00Z",
                "payout_usd": 0.0,
                "resolved_outcome": None,
            },
        ]
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        win_rate = calculate_win_rate(trades, as_of)
        assert win_rate == 0.0


class TestCalculateConsistencyScore:
    """Tests for calculate_consistency_score function."""

    def test_high_performer(self) -> None:
        score = calculate_consistency_score(
            win_rate=0.9,
            trade_count=25,
            profit_7d=1500.0,
        )
        # 0.9 * 40 = 36 + 30 (trades) + 30 (profit) = 96
        assert score == 96

    def test_emerging_trader(self) -> None:
        score = calculate_consistency_score(
            win_rate=0.7,
            trade_count=5,
            profit_7d=100.0,
        )
        # 0.7 * 40 = 28 + 15 (trades) + 20 (profit) = 63
        assert score == 63

    def test_losing_trader(self) -> None:
        score = calculate_consistency_score(
            win_rate=0.3,
            trade_count=10,
            profit_7d=-500.0,
        )
        # 0.3 * 40 = 12 + 25 (trades) + 0 (negative profit) = 37
        assert score == 37

    def test_score_capped_at_100(self) -> None:
        score = calculate_consistency_score(
            win_rate=1.0,
            trade_count=50,
            profit_7d=5000.0,
        )
        assert score == 100


class TestDetermineFlags:
    """Tests for determine_flags function."""

    @pytest.fixture
    def default_thresholds(self) -> dict:
        return {
            "high_profit_usd": 500.0,
            "high_consistency_score": 80,
            "min_trades_for_emerging": 3,
            "min_trades_for_suspicious": 10,
            "suspicious_win_rate": 0.95,
        }

    def test_high_profit_flag(self, default_thresholds: dict) -> None:
        flags = determine_flags(
            profit_7d=600.0,
            consistency_score=50,
            win_rate=0.6,
            trade_count=5,
            thresholds=default_thresholds,
        )
        assert "HighProfit" in flags

    def test_high_consistency_flag(self, default_thresholds: dict) -> None:
        flags = determine_flags(
            profit_7d=100.0,
            consistency_score=85,
            win_rate=0.8,
            trade_count=10,
            thresholds=default_thresholds,
        )
        assert "HighConsistency" in flags

    def test_emerging_flag(self, default_thresholds: dict) -> None:
        flags = determine_flags(
            profit_7d=50.0,
            consistency_score=60,
            win_rate=0.75,
            trade_count=5,
            thresholds=default_thresholds,
        )
        assert "Emerging" in flags

    def test_suspicious_flag(self, default_thresholds: dict) -> None:
        flags = determine_flags(
            profit_7d=1000.0,
            consistency_score=95,
            win_rate=0.98,
            trade_count=15,
            thresholds=default_thresholds,
        )
        assert "SuspiciouslyAccurate" in flags

    def test_multiple_flags(self, default_thresholds: dict) -> None:
        flags = determine_flags(
            profit_7d=1000.0,
            consistency_score=90,
            win_rate=0.97,
            trade_count=15,
            thresholds=default_thresholds,
        )
        assert "HighProfit" in flags
        assert "HighConsistency" in flags
        assert "SuspiciouslyAccurate" in flags


class TestCalculateWalletMetrics:
    """Tests for calculate_wallet_metrics function."""

    @pytest.fixture
    def sample_trades(self) -> list[dict]:
        return [
            {
                "type": "Buy",
                "timestamp": "2025-01-02T10:00:00Z",
                "amount_usd": 200.0,
                "payout_usd": 350.0,
                "resolved_outcome": "Yes",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-03T10:00:00Z",
                "amount_usd": 150.0,
                "payout_usd": 200.0,
                "resolved_outcome": "Yes",
            },
            {
                "type": "Buy",
                "timestamp": "2025-01-04T10:00:00Z",
                "amount_usd": 100.0,
                "payout_usd": 0.0,
                "resolved_outcome": "No",
            },
        ]

    @pytest.fixture
    def default_thresholds(self) -> dict:
        return {
            "high_profit_usd": 500.0,
            "high_consistency_score": 80,
            "min_trades_for_emerging": 3,
            "min_trades_for_suspicious": 10,
            "suspicious_win_rate": 0.95,
        }

    def test_full_metrics_calculation(
        self,
        sample_trades: list[dict],
        default_thresholds: dict,
    ) -> None:
        as_of = datetime(2025, 1, 5, tzinfo=timezone.utc)
        metrics = calculate_wallet_metrics(sample_trades, as_of, default_thresholds)

        assert "profit_7d" in metrics
        assert "roi" in metrics
        assert "win_rate" in metrics
        assert "consistency_score" in metrics
        assert "trade_count_7d" in metrics
        assert "flags" in metrics

        assert metrics["trade_count_7d"] == 3
        # Profit: (350-200) + (200-150) + (0-100) = 150 + 50 - 100 = 100
        assert metrics["profit_7d"] == 100.0
        # Win rate: 2/3
        assert abs(metrics["win_rate"] - 0.6667) < 0.01
