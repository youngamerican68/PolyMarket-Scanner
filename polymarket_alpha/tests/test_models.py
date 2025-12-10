"""Tests for Pydantic models."""

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from utils.models import (
    ClaudeInput,
    Trade,
    TradeType,
    Trader,
    WalletData,
    WalletFlag,
    WalletMetrics,
    ThresholdsConfig,
)


class TestTrade:
    """Tests for Trade model."""

    def test_valid_buy_trade(self) -> None:
        trade = Trade(
            type=TradeType.BUY,
            market_name="Will BTC hit 100k?",
            amount_usd=100.0,
            timestamp=datetime(2025, 1, 1, tzinfo=timezone.utc),
            resolved_outcome="Yes",
            payout_usd=150.0,
        )
        assert trade.type == TradeType.BUY
        assert trade.amount_usd == 100.0
        assert trade.payout_usd == 150.0

    def test_trade_from_string_timestamp(self) -> None:
        trade = Trade(
            type="Buy",  # type: ignore[arg-type]
            market_name="Test Market",
            amount_usd=50.0,
            timestamp="2025-01-02T13:45:00Z",
        )
        assert trade.timestamp.year == 2025
        assert trade.timestamp.month == 1
        assert trade.timestamp.day == 2

    def test_trade_empty_outcome_becomes_none(self) -> None:
        trade = Trade(
            type=TradeType.BUY,
            market_name="Test",
            timestamp=datetime.now(timezone.utc),
            resolved_outcome="",
        )
        assert trade.resolved_outcome is None

    def test_invalid_trade_type(self) -> None:
        with pytest.raises(ValidationError):
            Trade(
                type="Invalid",  # type: ignore[arg-type]
                market_name="Test",
                timestamp=datetime.now(timezone.utc),
            )

    def test_negative_amount_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Trade(
                type=TradeType.BUY,
                market_name="Test",
                amount_usd=-100.0,
                timestamp=datetime.now(timezone.utc),
            )

    def test_various_timestamp_formats(self) -> None:
        formats = [
            "2025-01-02T13:45:00Z",
            "2025-01-02T13:45:00.123Z",
            "2025-01-02",
            "2025-01-02 13:45:00",
        ]
        for ts in formats:
            trade = Trade(
                type=TradeType.BUY,
                market_name="Test",
                timestamp=ts,
            )
            assert trade.timestamp is not None


class TestTrader:
    """Tests for Trader model."""

    def test_valid_trader(self) -> None:
        trader = Trader(
            wallet_address="0xABC123",
            username="test_trader",
            volume_24h_usd=10000.0,
            profile_url="https://polymarket.com/@test_trader",
        )
        assert trader.wallet_address == "0xabc123"  # Normalized to lowercase
        assert trader.username == "test_trader"

    def test_trader_wallet_normalized(self) -> None:
        trader = Trader(
            wallet_address="  0xABC123DEF  ",
            username="test",
        )
        assert trader.wallet_address == "0xabc123def"

    def test_trader_requires_identifier(self) -> None:
        with pytest.raises(ValidationError):
            Trader(
                wallet_address="",
                username="",
            )

    def test_trader_username_only(self) -> None:
        trader = Trader(username="only_username")
        assert trader.wallet_address == ""
        assert trader.username == "only_username"


class TestWalletData:
    """Tests for WalletData model."""

    def test_wallet_data_with_trades(self) -> None:
        trades = [
            Trade(
                type=TradeType.BUY,
                market_name="Test 1",
                amount_usd=100.0,
                timestamp=datetime.now(timezone.utc),
            ),
            Trade(
                type=TradeType.SELL,
                market_name="Test 2",
                amount_usd=50.0,
                timestamp=datetime.now(timezone.utc),
            ),
        ]
        wallet = WalletData(
            wallet_address="0xabc123",
            username="trader1",
            trades=trades,
        )
        assert len(wallet.trades) == 2
        assert wallet.identifier == "0xabc123"

    def test_wallet_identifier_fallback(self) -> None:
        wallet = WalletData(
            wallet_address="",
            username="trader_only",
            trades=[],
        )
        assert wallet.identifier == "trader_only"


class TestWalletMetrics:
    """Tests for WalletMetrics model."""

    def test_metrics_with_flags(self) -> None:
        metrics = WalletMetrics(
            wallet_address="0xabc123",
            username="top_trader",
            profit_7d=1000.0,
            roi=0.25,
            win_rate=0.8,
            consistency_score=85,
            flags=[WalletFlag.HIGH_PROFIT, WalletFlag.HIGH_CONSISTENCY],
        )
        assert metrics.flags_str == "HighProfit|HighConsistency"

    def test_metrics_no_flags(self) -> None:
        metrics = WalletMetrics(
            wallet_address="0xabc123",
            profit_7d=50.0,
        )
        assert metrics.flags_str == ""

    def test_metrics_to_csv_row(self) -> None:
        metrics = WalletMetrics(
            wallet_address="0xabc123",
            username="trader1",
            profit_7d=500.0,
            roi=0.25,
            win_rate=0.75,
            consistency_score=80,
            flags=[WalletFlag.HIGH_PROFIT],
        )
        row = metrics.to_csv_row("2025-01-02")
        assert row[0] == "2025-01-02"
        assert row[1] == "0xabc123"
        assert row[2] == "trader1"
        assert row[3] == "500.00"
        assert row[7] == "HighProfit"

    def test_win_rate_bounds(self) -> None:
        # Valid
        WalletMetrics(wallet_address="0x1", win_rate=0.0)
        WalletMetrics(wallet_address="0x1", win_rate=1.0)

        # Invalid
        with pytest.raises(ValidationError):
            WalletMetrics(wallet_address="0x1", win_rate=-0.1)
        with pytest.raises(ValidationError):
            WalletMetrics(wallet_address="0x1", win_rate=1.1)

    def test_consistency_score_bounds(self) -> None:
        # Valid
        WalletMetrics(wallet_address="0x1", consistency_score=0)
        WalletMetrics(wallet_address="0x1", consistency_score=100)

        # Invalid
        with pytest.raises(ValidationError):
            WalletMetrics(wallet_address="0x1", consistency_score=-1)
        with pytest.raises(ValidationError):
            WalletMetrics(wallet_address="0x1", consistency_score=101)


class TestClaudeInput:
    """Tests for ClaudeInput model."""

    def test_valid_claude_input(self) -> None:
        input_data = ClaudeInput(
            as_of_date="2025-01-02",
            wallets=[
                WalletData(
                    wallet_address="0xabc123",
                    username="trader1",
                    trades=[],
                )
            ],
        )
        assert input_data.as_of_date == "2025-01-02"
        assert len(input_data.wallets) == 1

    def test_invalid_date_format(self) -> None:
        with pytest.raises(ValidationError):
            ClaudeInput(
                as_of_date="01-02-2025",  # Wrong format
                wallets=[],
            )


class TestThresholdsConfig:
    """Tests for ThresholdsConfig model."""

    def test_default_thresholds(self) -> None:
        config = ThresholdsConfig()
        assert config.high_profit_usd == 500.0
        assert config.high_consistency_score == 80
        assert config.suspicious_win_rate == 0.95

    def test_custom_thresholds(self) -> None:
        config = ThresholdsConfig(
            high_profit_usd=1000.0,
            suspicious_win_rate=0.90,
        )
        assert config.high_profit_usd == 1000.0
        assert config.suspicious_win_rate == 0.90

    def test_invalid_win_rate_threshold(self) -> None:
        with pytest.raises(ValidationError):
            ThresholdsConfig(suspicious_win_rate=1.5)
