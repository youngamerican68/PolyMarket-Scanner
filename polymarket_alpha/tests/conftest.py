"""Pytest configuration and shared fixtures."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generator

import pytest


@pytest.fixture
def sample_config() -> dict[str, Any]:
    """Sample configuration for testing."""
    return {
        "LOCAL_DEBUG": True,
        "google_sheets": {
            "credentials_path": "./credentials/service_account.json",
            "spreadsheet_id": "test_spreadsheet_id",
            "worksheet_name": "wallets",
            "data_range": "A:H",
        },
        "data_paths": {
            "top_traders": "./data/top_traders.json",
            "wallet_activity_dir": "./data/",
            "wallet_activity_pattern": "wallet_activity_{wallet}.json",
        },
        "output": {
            "markdown_report_path": "./output/daily_report.md",
            "csv_output_path": "./output/wallet_metrics.csv",
        },
        "thresholds": {
            "high_profit_usd": 500.0,
            "high_consistency_score": 80,
            "min_trades_for_emerging": 3,
            "min_trades_for_suspicious": 10,
            "suspicious_win_rate": 0.95,
        },
    }


@pytest.fixture
def sample_traders() -> list[dict[str, Any]]:
    """Sample trader data for testing."""
    return [
        {
            "wallet_address": "0xabc123def456",
            "username": "trader_alpha",
            "volume_24h_usd": 15000.50,
            "profile_url": "https://polymarket.com/@trader_alpha",
        },
        {
            "wallet_address": "0xdef789ghi012",
            "username": "whale_trader",
            "volume_24h_usd": 250000.00,
            "profile_url": "https://polymarket.com/@whale_trader",
        },
        {
            "wallet_address": "0x123456789abc",
            "username": "consistent_winner",
            "volume_24h_usd": 8500.25,
            "profile_url": "https://polymarket.com/@consistent_winner",
        },
    ]


@pytest.fixture
def sample_trades() -> list[dict[str, Any]]:
    """Sample trade data for testing."""
    return [
        {
            "type": "Buy",
            "market_name": "Will BTC be above 100k by 2025?",
            "amount_usd": 150.0,
            "timestamp": "2025-01-02T13:45:00Z",
            "resolved_outcome": "Yes",
            "payout_usd": 220.0,
        },
        {
            "type": "Buy",
            "market_name": "Will ETH flip BTC?",
            "amount_usd": 100.0,
            "timestamp": "2025-01-01T10:00:00Z",
            "resolved_outcome": "No",
            "payout_usd": 0.0,
        },
        {
            "type": "Buy",
            "market_name": "Trump wins 2024?",
            "amount_usd": 200.0,
            "timestamp": "2024-12-28T08:00:00Z",
            "resolved_outcome": "Yes",
            "payout_usd": 350.0,
        },
        {
            "type": "Sell",
            "market_name": "Market pullback in Jan?",
            "amount_usd": 50.0,
            "timestamp": "2025-01-02T09:00:00Z",
            "resolved_outcome": None,
            "payout_usd": 0.0,
        },
    ]


@pytest.fixture
def sample_wallet_activity() -> dict[str, Any]:
    """Sample wallet activity structure."""
    return {
        "wallets": [
            {
                "wallet_address": "0xabc123",
                "username": "trader1",
                "activities": [
                    {
                        "type": "Buy",
                        "market_name": "Test Market 1",
                        "amount_usd": 100.0,
                        "timestamp": "2025-01-02T10:00:00Z",
                        "resolved_outcome": "Yes",
                        "payout_usd": 150.0,
                    },
                    {
                        "type": "Sell",
                        "market_name": "Test Market 2",
                        "amount_usd": 75.0,
                        "timestamp": "2025-01-03T10:00:00Z",
                        "resolved_outcome": None,
                        "payout_usd": 0.0,
                    },
                ],
            },
            {
                "wallet_address": "0xdef456",
                "username": "trader2",
                "activities": [
                    {
                        "type": "Buy",
                        "market_name": "Test Market 3",
                        "amount_usd": 500.0,
                        "timestamp": "2025-01-02T14:00:00Z",
                        "resolved_outcome": "Yes",
                        "payout_usd": 800.0,
                    },
                ],
            },
        ]
    }


@pytest.fixture
def as_of_date() -> datetime:
    """Standard as_of_date for testing."""
    return datetime(2025, 1, 5, tzinfo=timezone.utc)


@pytest.fixture
def default_thresholds() -> dict[str, Any]:
    """Default threshold configuration."""
    return {
        "high_profit_usd": 500.0,
        "high_consistency_score": 80,
        "min_trades_for_emerging": 3,
        "min_trades_for_suspicious": 10,
        "suspicious_win_rate": 0.95,
    }


@pytest.fixture
def temp_json_file(tmp_path: Path) -> Generator[tuple[Path, Any], None, None]:
    """Create a temporary JSON file for testing."""
    def _create_file(data: Any, filename: str = "test.json") -> Path:
        file_path = tmp_path / filename
        with open(file_path, "w") as f:
            json.dump(data, f)
        return file_path

    yield _create_file, tmp_path  # type: ignore[misc]


@pytest.fixture
def mock_claude_response() -> str:
    """Mock Claude API response."""
    return """## Daily Wallet Analysis Report

| Wallet | Username | Profit_7d | ROI | Win_Rate | Consistency | Flags | Notes |
|--------|----------|-----------|-----|----------|-------------|-------|-------|
| 0xabc123... | trader1 | $500.00 | 25.00% | 75.00% | 85 | HighProfit | Top performer |
| 0xdef456... | trader2 | $150.00 | 10.00% | 60.00% | 65 | - | - |

```csv
date,wallet_address,username,profit_7d,roi,win_rate,consistency_score,flags
2025-01-02,0xabc123,trader1,500.00,0.2500,0.7500,85,HighProfit
2025-01-02,0xdef456,trader2,150.00,0.1000,0.6000,65,
```
"""
