"""
Custom exceptions for Polymarket Alpha Wallet Tracker.
Provides specific error types for better error handling and debugging.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class PolymarketAlphaError(Exception):
    """Base exception for all Polymarket Alpha errors."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(self.message)

    def __str__(self) -> str:
        if self.details:
            return f"{self.message} | Details: {self.details}"
        return self.message


# Configuration Errors
class ConfigurationError(PolymarketAlphaError):
    """Raised when there's an issue with configuration."""

    pass


class MissingConfigError(ConfigurationError):
    """Raised when a required configuration value is missing."""

    def __init__(self, config_key: str, config_path: Optional[str] = None) -> None:
        details: Dict[str, Any] = {"config_key": config_key}
        if config_path:
            details["config_path"] = config_path
        super().__init__(f"Missing required configuration: {config_key}", details)


class InvalidConfigError(ConfigurationError):
    """Raised when a configuration value is invalid."""

    def __init__(self, config_key: str, value: Any, expected: str) -> None:
        super().__init__(
            f"Invalid configuration for '{config_key}': expected {expected}",
            {"config_key": config_key, "value": value, "expected": expected},
        )


# Data Loading Errors
class DataLoadError(PolymarketAlphaError):
    """Base class for data loading errors."""

    pass


class FileNotFoundError(DataLoadError):
    """Raised when a required data file is not found."""

    def __init__(self, file_path: str, file_type: str = "data") -> None:
        super().__init__(
            f"{file_type.capitalize()} file not found: {file_path}",
            {"file_path": file_path, "file_type": file_type},
        )


class InvalidJSONError(DataLoadError):
    """Raised when JSON parsing fails."""

    def __init__(self, file_path: str, error: str) -> None:
        super().__init__(
            f"Invalid JSON in file: {file_path}",
            {"file_path": file_path, "parse_error": error},
        )


class InvalidDataStructureError(DataLoadError):
    """Raised when data doesn't match expected structure."""

    def __init__(self, file_path: str, expected: str, got: str) -> None:
        super().__init__(
            f"Unexpected data structure in {file_path}",
            {"file_path": file_path, "expected": expected, "got": got},
        )


# Validation Errors
class ValidationError(PolymarketAlphaError):
    """Base class for validation errors."""

    pass


class TraderValidationError(ValidationError):
    """Raised when trader data fails validation."""

    def __init__(self, trader_data: Dict[str, Any], reason: str) -> None:
        super().__init__(
            f"Trader validation failed: {reason}",
            {"trader_data": trader_data, "reason": reason},
        )


class TradeValidationError(ValidationError):
    """Raised when trade data fails validation."""

    def __init__(self, trade_data: Dict[str, Any], reason: str) -> None:
        super().__init__(
            f"Trade validation failed: {reason}",
            {"trade_data": trade_data, "reason": reason},
        )


# API Errors
class APIError(PolymarketAlphaError):
    """Base class for API-related errors."""

    pass


class ClaudeAPIError(APIError):
    """Raised when Claude API call fails."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[str] = None,
    ) -> None:
        details: Dict[str, Any] = {}
        if status_code:
            details["status_code"] = status_code
        if response_body:
            details["response_body"] = response_body[:500]  # Truncate long responses
        super().__init__(f"Claude API error: {message}", details)


class ClaudeResponseParseError(APIError):
    """Raised when Claude's response cannot be parsed."""

    def __init__(self, reason: str, response_snippet: Optional[str] = None) -> None:
        details: Dict[str, Any] = {"reason": reason}
        if response_snippet:
            details["response_snippet"] = response_snippet[:200]
        super().__init__(f"Failed to parse Claude response: {reason}", details)


class GoogleSheetsError(APIError):
    """Raised when Google Sheets operation fails."""

    def __init__(self, operation: str, error: str) -> None:
        super().__init__(
            f"Google Sheets {operation} failed: {error}",
            {"operation": operation, "error": error},
        )


class SheetsAuthenticationError(GoogleSheetsError):
    """Raised when Google Sheets authentication fails."""

    def __init__(self, credentials_path: str, error: str) -> None:
        super().__init__(
            "authentication",
            f"Failed to authenticate with credentials at {credentials_path}: {error}",
        )
        self.details["credentials_path"] = credentials_path


# Processing Errors
class ProcessingError(PolymarketAlphaError):
    """Base class for data processing errors."""

    pass


class MetricsCalculationError(ProcessingError):
    """Raised when metrics calculation fails."""

    def __init__(self, wallet_address: str, metric: str, error: str) -> None:
        super().__init__(
            f"Failed to calculate {metric} for wallet {wallet_address[:16]}...",
            {"wallet_address": wallet_address, "metric": metric, "error": error},
        )


class CSVParseError(ProcessingError):
    """Raised when CSV parsing fails."""

    def __init__(self, line_number: int, line_content: str, error: str) -> None:
        super().__init__(
            f"CSV parse error at line {line_number}",
            {
                "line_number": line_number,
                "line_content": line_content[:100],
                "error": error,
            },
        )


# Pipeline Errors
class PipelineError(PolymarketAlphaError):
    """Raised when the pipeline fails at a specific step."""

    def __init__(self, step: str, reason: str, recoverable: bool = False) -> None:
        super().__init__(
            f"Pipeline failed at step '{step}': {reason}",
            {"step": step, "reason": reason, "recoverable": recoverable},
        )
        self.recoverable = recoverable


class NoDataError(PipelineError):
    """Raised when no data is available to process."""

    def __init__(self, data_type: str, step: str) -> None:
        super().__init__(
            step=step,
            reason=f"No {data_type} data available",
            recoverable=False,
        )
