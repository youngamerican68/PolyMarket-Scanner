"""
Utils package for Polymarket Alpha Wallet Tracker.

This package provides core utilities for:
- Data normalization and validation
- Profit/metrics calculations
- Google Sheets integration
- Claude API client
- Logging configuration
- Async data loading
- Custom exceptions
- Pydantic models
"""

from .normalize import (
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

from .profit_calc import (
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

from .sheets import (
    SheetsClient,
    csv_rows_to_sheets_format,
    load_config,
)

from .exceptions import (
    PolymarketAlphaError,
    ConfigurationError,
    MissingConfigError,
    InvalidConfigError,
    DataLoadError,
    ValidationError,
    TraderValidationError,
    TradeValidationError,
    APIError,
    ClaudeAPIError,
    ClaudeResponseParseError,
    GoogleSheetsError,
    SheetsAuthenticationError,
    ProcessingError,
    MetricsCalculationError,
    CSVParseError,
    PipelineError,
    NoDataError,
)

from .models import (
    Trade,
    TradeType,
    Trader,
    WalletData,
    WalletFlag,
    WalletMetrics,
    ClaudeInput,
    ThresholdsConfig,
    GoogleSheetsConfig,
    DataPathsConfig,
    OutputConfig,
    ClaudeConfig,
    AppConfig,
    CSV_HEADERS,
)

from .logging_config import (
    setup_logging,
    get_logger,
    log_step,
    log_success,
    log_wallet_info,
    print_banner,
    console,
)

from .claude_client import (
    OpenRouterClient,
    ClaudeClient,  # Alias for backward compatibility
    LocalAnalyzer,
    get_analyzer,
    OPENROUTER_MODELS,
)

from .async_loader import (
    AsyncDataLoader,
    load_json_file_async,
    load_wallet_activity_async,
    load_all_wallet_activities_async,
    run_async,
)

from .database import (
    DatabaseClient,
    get_storage_client,
    DEFAULT_DB_PATH,
)

__all__ = [
    # Normalize
    "ALLOWED_TRADE_TYPES",
    "build_claude_input_json",
    "extract_csv_block_from_claude_response",
    "extract_markdown_block_from_claude_response",
    "normalize_timestamp",
    "normalize_trade_entry",
    "normalize_trade_type",
    "normalize_trader_entry",
    "normalize_usd_value",
    "normalize_wallet_address",
    "parse_claude_csv_output",
    "sanitize_wallet_for_filename",
    # Profit calc
    "calculate_consistency_score",
    "calculate_profit_7d",
    "calculate_roi",
    "calculate_total_staked_7d",
    "calculate_trade_pnl",
    "calculate_wallet_metrics",
    "calculate_win_rate",
    "determine_flags",
    "filter_trades_by_date_range",
    # Sheets
    "SheetsClient",
    "csv_rows_to_sheets_format",
    "load_config",
    # Exceptions
    "PolymarketAlphaError",
    "ConfigurationError",
    "MissingConfigError",
    "InvalidConfigError",
    "DataLoadError",
    "ValidationError",
    "TraderValidationError",
    "TradeValidationError",
    "APIError",
    "ClaudeAPIError",
    "ClaudeResponseParseError",
    "GoogleSheetsError",
    "SheetsAuthenticationError",
    "ProcessingError",
    "MetricsCalculationError",
    "CSVParseError",
    "PipelineError",
    "NoDataError",
    # Models
    "Trade",
    "TradeType",
    "Trader",
    "WalletData",
    "WalletFlag",
    "WalletMetrics",
    "ClaudeInput",
    "ThresholdsConfig",
    "GoogleSheetsConfig",
    "DataPathsConfig",
    "OutputConfig",
    "ClaudeConfig",
    "AppConfig",
    "CSV_HEADERS",
    # Logging
    "setup_logging",
    "get_logger",
    "log_step",
    "log_success",
    "log_wallet_info",
    "print_banner",
    "console",
    # LLM client (OpenRouter)
    "OpenRouterClient",
    "ClaudeClient",  # Alias for backward compatibility
    "LocalAnalyzer",
    "get_analyzer",
    "OPENROUTER_MODELS",
    # Async loader
    "AsyncDataLoader",
    "load_json_file_async",
    "load_wallet_activity_async",
    "load_all_wallet_activities_async",
    "run_async",
    # Database (SQLite storage)
    "DatabaseClient",
    "get_storage_client",
    "DEFAULT_DB_PATH",
]
