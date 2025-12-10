"""Tests for normalization functions."""

from datetime import datetime, timezone

import pytest

from utils.normalize import (
    ALLOWED_TRADE_TYPES,
    build_claude_input_json,
    extract_csv_block_from_claude_response,
    extract_markdown_block_from_claude_response,
    normalize_timestamp,
    normalize_trade_entry,
    normalize_trade_type,
    normalize_trader_entry,
    normalize_usd_value,
    normalize_wallet_address,
    parse_claude_csv_output,
    sanitize_wallet_for_filename,
)


class TestNormalizeTimestamp:
    """Tests for normalize_timestamp function."""

    def test_iso_format_with_z(self) -> None:
        result = normalize_timestamp("2025-01-02T13:45:00Z")
        assert result.year == 2025
        assert result.month == 1
        assert result.day == 2
        assert result.hour == 13
        assert result.minute == 45

    def test_iso_format_with_milliseconds(self) -> None:
        result = normalize_timestamp("2025-01-02T13:45:00.123Z")
        assert result.year == 2025

    def test_date_only(self) -> None:
        result = normalize_timestamp("2025-01-02")
        assert result.year == 2025
        assert result.month == 1
        assert result.day == 2

    def test_empty_string_returns_now(self) -> None:
        result = normalize_timestamp("")
        assert result.year == datetime.now().year

    def test_unparseable_returns_now(self) -> None:
        result = normalize_timestamp("invalid timestamp")
        assert result.year == datetime.now().year


class TestNormalizeTradeType:
    """Tests for normalize_trade_type function."""

    def test_valid_types(self) -> None:
        assert normalize_trade_type("Buy") == "Buy"
        assert normalize_trade_type("buy") == "Buy"
        assert normalize_trade_type("BUY") == "Buy"
        assert normalize_trade_type("Sell") == "Sell"
        assert normalize_trade_type("Redeem") == "Redeem"

    def test_invalid_types(self) -> None:
        assert normalize_trade_type("Deposit") is None
        assert normalize_trade_type("Withdraw") is None
        assert normalize_trade_type("Invalid") is None

    def test_empty_string(self) -> None:
        assert normalize_trade_type("") is None
        assert normalize_trade_type(None) is None  # type: ignore[arg-type]

    def test_whitespace_trimmed(self) -> None:
        assert normalize_trade_type("  Buy  ") == "Buy"


class TestNormalizeUsdValue:
    """Tests for normalize_usd_value function."""

    def test_numeric_values(self) -> None:
        assert normalize_usd_value(100) == 100.0
        assert normalize_usd_value(100.5) == 100.5
        assert normalize_usd_value(0) == 0.0

    def test_string_values(self) -> None:
        assert normalize_usd_value("100") == 100.0
        assert normalize_usd_value("$100.50") == 100.5
        assert normalize_usd_value("$1,000.00") == 1000.0

    def test_none_value(self) -> None:
        assert normalize_usd_value(None) == 0.0

    def test_invalid_string(self) -> None:
        assert normalize_usd_value("invalid") == 0.0


class TestNormalizeWalletAddress:
    """Tests for normalize_wallet_address function."""

    def test_lowercase_conversion(self) -> None:
        assert normalize_wallet_address("0xABC123") == "0xabc123"

    def test_whitespace_trimmed(self) -> None:
        assert normalize_wallet_address("  0xabc123  ") == "0xabc123"

    def test_empty_string(self) -> None:
        assert normalize_wallet_address("") == ""
        assert normalize_wallet_address(None) == ""  # type: ignore[arg-type]


class TestSanitizeWalletForFilename:
    """Tests for sanitize_wallet_for_filename function."""

    def test_basic_sanitization(self) -> None:
        result = sanitize_wallet_for_filename("0xABC123")
        assert result == "0xABC123"

    def test_special_chars_replaced(self) -> None:
        result = sanitize_wallet_for_filename("user/name@test")
        assert "/" not in result
        assert "@" not in result

    def test_length_limit(self) -> None:
        long_address = "0x" + "a" * 100
        result = sanitize_wallet_for_filename(long_address)
        assert len(result) <= 50


class TestNormalizeTradeEntry:
    """Tests for normalize_trade_entry function."""

    def test_valid_trade(self) -> None:
        raw_trade = {
            "type": "Buy",
            "market_name": "Test Market",
            "amount_usd": "$100.00",
            "timestamp": "2025-01-02T10:00:00Z",
            "resolved_outcome": "Yes",
            "payout_usd": 150.0,
        }
        result = normalize_trade_entry(raw_trade)
        assert result is not None
        assert result["type"] == "Buy"
        assert result["amount_usd"] == 100.0
        assert result["payout_usd"] == 150.0

    def test_invalid_trade_type_returns_none(self) -> None:
        raw_trade = {
            "type": "Deposit",
            "market_name": "Test",
            "amount_usd": 100.0,
            "timestamp": "2025-01-02T10:00:00Z",
        }
        result = normalize_trade_entry(raw_trade)
        assert result is None


class TestNormalizeTraderEntry:
    """Tests for normalize_trader_entry function."""

    def test_valid_trader(self) -> None:
        raw_trader = {
            "wallet_address": "0xABC123",
            "username": "test_trader",
            "volume_24h_usd": "$10,000.00",
            "profile_url": "https://polymarket.com/@test_trader",
        }
        result = normalize_trader_entry(raw_trader)
        assert result["wallet_address"] == "0xabc123"
        assert result["username"] == "test_trader"
        assert result["volume_24h_usd"] == 10000.0


class TestParseClaudeCsvOutput:
    """Tests for parse_claude_csv_output function."""

    def test_valid_csv(self) -> None:
        csv_text = """date,wallet_address,username,profit_7d,roi,win_rate,consistency_score,flags
2025-01-02,0xabc123,trader1,500.00,0.25,0.75,85,HighProfit
2025-01-02,0xdef456,trader2,150.00,0.10,0.60,65,"""
        rows = parse_claude_csv_output(csv_text)
        assert len(rows) == 3  # Header + 2 data rows
        assert rows[0][0] == "date"
        assert rows[1][1] == "0xabc123"

    def test_empty_lines_ignored(self) -> None:
        csv_text = """date,wallet,profit

2025-01-02,0xabc,100

2025-01-02,0xdef,200
"""
        rows = parse_claude_csv_output(csv_text)
        assert len(rows) == 3

    def test_empty_input(self) -> None:
        rows = parse_claude_csv_output("")
        assert rows == []


class TestExtractCsvBlock:
    """Tests for extract_csv_block_from_claude_response function."""

    def test_extract_csv_block(self) -> None:
        response = """## Analysis Report

Some text here.

```csv
date,wallet,profit
2025-01-02,0xabc,100
```

More text."""
        csv = extract_csv_block_from_claude_response(response)
        assert "date,wallet,profit" in csv
        assert "0xabc" in csv

    def test_extract_generic_code_block(self) -> None:
        response = """## Report

```
date,wallet,profit
2025-01-02,0xabc,100
```"""
        csv = extract_csv_block_from_claude_response(response)
        assert "date,wallet,profit" in csv

    def test_no_csv_block(self) -> None:
        response = "Just some text without code blocks"
        csv = extract_csv_block_from_claude_response(response)
        assert csv == ""


class TestExtractMarkdownBlock:
    """Tests for extract_markdown_block_from_claude_response function."""

    def test_extract_markdown_before_csv(self) -> None:
        response = """## Analysis Report

| Col1 | Col2 |
|------|------|
| A    | B    |

```csv
date,wallet
```"""
        md = extract_markdown_block_from_claude_response(response)
        assert "Analysis Report" in md
        assert "csv" not in md

    def test_full_response_if_no_code_block(self) -> None:
        response = "## Just a markdown report"
        md = extract_markdown_block_from_claude_response(response)
        assert md == "## Just a markdown report"


class TestBuildClaudeInputJson:
    """Tests for build_claude_input_json function."""

    def test_build_input(self) -> None:
        wallets = [
            {"wallet_address": "0xabc", "username": "trader1", "trades": []},
        ]
        result = build_claude_input_json("2025-01-02", wallets)
        assert result["as_of_date"] == "2025-01-02"
        assert len(result["wallets"]) == 1
        assert result["wallets"][0]["wallet_address"] == "0xabc"
