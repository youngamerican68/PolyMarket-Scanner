"""
Pydantic models for data validation in Polymarket Alpha Wallet Tracker.
Provides type-safe data structures with automatic validation.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)


class TradeType(str, Enum):
    """Allowed trade types."""

    BUY = "Buy"
    SELL = "Sell"
    REDEEM = "Redeem"


class WalletFlag(str, Enum):
    """Wallet classification flags."""

    HIGH_PROFIT = "HighProfit"
    HIGH_CONSISTENCY = "HighConsistency"
    EMERGING = "Emerging"
    SUSPICIOUSLY_ACCURATE = "SuspiciouslyAccurate"


class Trade(BaseModel):
    """Validated trade/activity data."""

    model_config = ConfigDict(str_strip_whitespace=True)

    type: TradeType
    market_name: str = Field(default="", max_length=500)
    amount_usd: float = Field(default=0.0, ge=0)
    timestamp: datetime
    resolved_outcome: Optional[str] = None
    payout_usd: float = Field(default=0.0, ge=0)

    @field_validator("resolved_outcome", mode="before")
    @classmethod
    def empty_string_to_none(cls, v: Any) -> Optional[str]:
        if v == "" or v is None:
            return None
        return str(v).strip()

    @field_validator("timestamp", mode="before")
    @classmethod
    def parse_timestamp(cls, v: Any) -> datetime:
        if isinstance(v, datetime):
            return v
        if isinstance(v, str):
            # Try multiple formats
            formats = [
                "%Y-%m-%dT%H:%M:%SZ",
                "%Y-%m-%dT%H:%M:%S.%fZ",
                "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%S.%f%z",
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d",
            ]
            for fmt in formats:
                try:
                    return datetime.strptime(v.strip(), fmt)
                except ValueError:
                    continue
            raise ValueError(f"Unable to parse timestamp: {v}")
        raise ValueError(f"Invalid timestamp type: {type(v)}")


class Trader(BaseModel):
    """Validated trader data."""

    model_config = ConfigDict(str_strip_whitespace=True)

    wallet_address: str = Field(default="", max_length=100)
    username: str = Field(default="", max_length=100)
    volume_24h_usd: Annotated[float, Field(ge=0)] = 0.0
    profile_url: str = Field(default="", max_length=500)

    @field_validator("wallet_address", mode="before")
    @classmethod
    def normalize_wallet(cls, v: Any) -> str:
        if v is None:
            return ""
        return str(v).strip().lower()

    @model_validator(mode="after")
    def require_identifier(self) -> "Trader":
        """Ensure at least wallet_address or username is provided."""
        if not self.wallet_address and not self.username:
            raise ValueError("Either wallet_address or username must be provided")
        return self


class WalletData(BaseModel):
    """Wallet data structure for Claude analysis."""

    model_config = ConfigDict(str_strip_whitespace=True)

    wallet_address: str
    username: str = ""
    trades: List[Trade] = Field(default_factory=list)

    @property
    def identifier(self) -> str:
        """Return the best identifier for this wallet."""
        return self.wallet_address or self.username


class WalletMetrics(BaseModel):
    """Calculated metrics for a wallet."""

    model_config = ConfigDict(str_strip_whitespace=True)

    wallet_address: str
    username: str = ""
    profit_7d: float = 0.0
    total_staked_7d: float = 0.0
    roi: float = Field(default=0.0, ge=-1.0, le=100.0)  # Allow for very high ROI
    win_rate: float = Field(default=0.0, ge=0.0, le=1.0)
    consistency_score: int = Field(default=0, ge=0, le=100)
    trade_count_7d: int = Field(default=0, ge=0)
    flags: List[WalletFlag] = Field(default_factory=list)

    @property
    def flags_str(self) -> str:
        """Return flags as pipe-separated string."""
        return "|".join(f.value for f in self.flags) if self.flags else ""

    def to_csv_row(self, date: str) -> List[str]:
        """Convert metrics to CSV row format."""
        return [
            date,
            self.wallet_address,
            self.username,
            f"{self.profit_7d:.2f}",
            f"{self.roi:.4f}",
            f"{self.win_rate:.4f}",
            str(self.consistency_score),
            self.flags_str,
        ]


class ClaudeInput(BaseModel):
    """Input structure for Claude analysis."""

    as_of_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    wallets: List[WalletData] = Field(default_factory=list)


class ThresholdsConfig(BaseModel):
    """Threshold configuration for flag determination."""

    high_profit_usd: float = Field(default=500.0, gt=0)
    high_consistency_score: int = Field(default=80, ge=0, le=100)
    min_trades_for_emerging: int = Field(default=3, ge=1)
    min_trades_for_suspicious: int = Field(default=10, ge=1)
    suspicious_win_rate: float = Field(default=0.95, ge=0.0, le=1.0)


class GoogleSheetsConfig(BaseModel):
    """Google Sheets configuration."""

    credentials_path: str
    spreadsheet_id: str
    worksheet_name: str = "wallets"
    data_range: str = "A:H"


class DataPathsConfig(BaseModel):
    """Data paths configuration."""

    top_traders: str = "./data/top_traders.json"
    wallet_activity_dir: str = "./data/"
    wallet_activity_pattern: str = "wallet_activity_{wallet}.json"


class OutputConfig(BaseModel):
    """Output paths configuration."""

    markdown_report_path: str = "./output/daily_report.md"
    csv_output_path: str = "./output/wallet_metrics.csv"


class ClaudeConfig(BaseModel):
    """Claude API configuration."""

    prompt_path: str = "./prompts/Claude_Wallet_Analysis_Prompt.md"
    model: str = "claude-sonnet-4-20250514"
    max_tokens: int = 4096
    api_key: Optional[str] = None  # Can be set via environment variable


class AppConfig(BaseModel):
    """Complete application configuration."""

    model_config = ConfigDict(extra="allow")  # Allow extra fields for flexibility

    LOCAL_DEBUG: bool = True
    google_sheets: Optional[GoogleSheetsConfig] = None
    data_paths: DataPathsConfig = Field(default_factory=DataPathsConfig)
    example_paths: Dict[str, str] = Field(default_factory=dict)
    output: OutputConfig = Field(default_factory=OutputConfig)
    claude: ClaudeConfig = Field(default_factory=ClaudeConfig)
    thresholds: ThresholdsConfig = Field(default_factory=ThresholdsConfig)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AppConfig":
        """Create config from dictionary with proper nested parsing."""
        return cls(**data)


# CSV Output Schema
CSV_HEADERS = [
    "date",
    "wallet_address",
    "username",
    "profit_7d",
    "roi",
    "win_rate",
    "consistency_score",
    "flags",
]
