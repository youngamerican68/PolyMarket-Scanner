"""
LLM API client for Polymarket Alpha Wallet Tracker.
Supports OpenRouter for access to Claude and other models.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

from .exceptions import ClaudeAPIError, ClaudeResponseParseError
from .logging_config import get_logger
from .models import ClaudeInput, ThresholdsConfig, WalletFlag, WalletMetrics

logger = get_logger(__name__)

# OpenRouter API endpoint
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Default models available on OpenRouter
OPENROUTER_MODELS = {
    # Anthropic
    "claude-sonnet": "anthropic/claude-sonnet-4",
    "claude-opus": "anthropic/claude-opus-4",
    "claude-haiku": "anthropic/claude-3.5-haiku",
    # OpenAI
    "gpt-4o": "openai/gpt-4o",
    "gpt-4o-mini": "openai/gpt-4o-mini",
    # Google
    "gemini-flash": "google/gemini-2.0-flash-001",
    "gemini-pro": "google/gemini-pro-1.5",
    # Meta
    "llama-70b": "meta-llama/llama-3.1-70b-instruct",
}


class OpenRouterClient:
    """Client for OpenRouter API - provides access to Claude and other models."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "anthropic/claude-sonnet-4",
        max_tokens: int = 4096,
        site_url: Optional[str] = None,
        site_name: Optional[str] = None,
    ) -> None:
        """
        Initialize OpenRouter client.

        Args:
            api_key: OpenRouter API key (defaults to OPENROUTER_API_KEY env var)
            model: Model to use (e.g., "anthropic/claude-sonnet-4")
            max_tokens: Maximum tokens in response
            site_url: Optional URL for your app (for OpenRouter rankings)
            site_name: Optional name for your app
        """
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        self.model = self._resolve_model(model)
        self.max_tokens = max_tokens
        self.site_url = site_url or "https://github.com/polymarket/polymarket-alpha"
        self.site_name = site_name or "Polymarket Alpha Tracker"
        self._client: Optional[httpx.Client] = None

        if not HTTPX_AVAILABLE:
            logger.warning("httpx package not installed. Run: pip install httpx")

    def _resolve_model(self, model: str) -> str:
        """Resolve model shorthand to full OpenRouter model ID."""
        # Check if it's a shorthand
        if model in OPENROUTER_MODELS:
            return OPENROUTER_MODELS[model]
        # Check if it looks like an OpenRouter model ID already
        if "/" in model:
            return model
        # Default to Claude Sonnet
        logger.warning(f"Unknown model '{model}', defaulting to anthropic/claude-sonnet-4")
        return "anthropic/claude-sonnet-4"

    def _get_client(self) -> httpx.Client:
        """Get or create the HTTP client."""
        if self._client is None:
            if not HTTPX_AVAILABLE:
                raise ClaudeAPIError("httpx package not installed. Run: pip install httpx")
            if not self.api_key:
                raise ClaudeAPIError(
                    "OPENROUTER_API_KEY not set. Get your key at https://openrouter.ai/keys"
                )
            self._client = httpx.Client(timeout=120.0)
        return self._client

    def load_prompt_template(self, prompt_path: str) -> str:
        """
        Load the prompt template from file.

        Args:
            prompt_path: Path to the prompt template file

        Returns:
            Prompt template string

        Raises:
            ClaudeAPIError: If template file cannot be loaded
        """
        path = Path(prompt_path)
        if not path.exists():
            raise ClaudeAPIError(f"Prompt template not found: {prompt_path}")

        try:
            template = path.read_text(encoding="utf-8")
            logger.info(f"Loaded prompt template from: {prompt_path}")
            return template
        except Exception as e:
            raise ClaudeAPIError(f"Failed to load prompt template: {e}")

    def prepare_prompt(
        self,
        template: str,
        claude_input: Union[ClaudeInput, Dict[str, Any]],
    ) -> str:
        """
        Prepare the full prompt with wallet data.

        Args:
            template: Prompt template with {{wallet_json}} placeholder
            claude_input: Input data for analysis

        Returns:
            Completed prompt string
        """
        if isinstance(claude_input, ClaudeInput):
            input_dict = claude_input.model_dump(mode="json")
        else:
            input_dict = claude_input

        wallet_json_str = json.dumps(input_dict, indent=2, default=str)
        return template.replace("{{wallet_json}}", wallet_json_str)

    def analyze(
        self,
        claude_input: Union[ClaudeInput, Dict[str, Any]],
        prompt_template: str,
    ) -> str:
        """
        Send data to OpenRouter for analysis.

        Args:
            claude_input: Input data for analysis
            prompt_template: Prompt template with placeholder

        Returns:
            Model's response text

        Raises:
            ClaudeAPIError: If API call fails
        """
        client = self._get_client()
        full_prompt = self.prepare_prompt(prompt_template, claude_input)

        wallet_count = len(
            claude_input.get("wallets", [])
            if isinstance(claude_input, dict)
            else claude_input.wallets
        )
        logger.info(f"Sending request to OpenRouter ({self.model})")
        logger.debug(f"Input contains {wallet_count} wallets")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": self.site_url,
            "X-Title": self.site_name,
        }

        payload = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": [{"role": "user", "content": full_prompt}],
        }

        try:
            response = client.post(
                OPENROUTER_API_URL,
                headers=headers,
                json=payload,
            )

            if response.status_code == 429:
                raise ClaudeAPIError("Rate limit exceeded", status_code=429)

            if response.status_code != 200:
                error_body = response.text[:500]
                raise ClaudeAPIError(
                    f"API returned status {response.status_code}",
                    status_code=response.status_code,
                    response_body=error_body,
                )

            data = response.json()

            # Check for error in response
            if "error" in data:
                error_msg = data["error"].get("message", str(data["error"]))
                raise ClaudeAPIError(f"API error: {error_msg}")

            # Extract response text
            choices = data.get("choices", [])
            if not choices:
                raise ClaudeAPIError("No response choices returned")

            response_text = choices[0].get("message", {}).get("content", "")
            if not response_text:
                raise ClaudeAPIError("Empty response content")

            # Log usage if available
            usage = data.get("usage", {})
            if usage:
                logger.debug(
                    f"Tokens used - prompt: {usage.get('prompt_tokens', '?')}, "
                    f"completion: {usage.get('completion_tokens', '?')}"
                )

            logger.info(f"Received response ({len(response_text)} chars)")
            return response_text

        except httpx.TimeoutException:
            raise ClaudeAPIError("Request timed out")
        except httpx.RequestError as e:
            raise ClaudeAPIError(f"Connection error: {e}")
        except json.JSONDecodeError as e:
            raise ClaudeAPIError(f"Failed to parse API response: {e}")

    def analyze_with_retry(
        self,
        claude_input: Union[ClaudeInput, Dict[str, Any]],
        prompt_template: str,
        max_retries: int = 3,
    ) -> str:
        """
        Send data with retry logic.

        Args:
            claude_input: Input data for analysis
            prompt_template: Prompt template
            max_retries: Maximum retry attempts

        Returns:
            Model's response text
        """
        last_error: Optional[Exception] = None

        for attempt in range(max_retries):
            try:
                return self.analyze(claude_input, prompt_template)
            except ClaudeAPIError as e:
                last_error = e
                if "rate limit" in str(e).lower() or e.details.get("status_code") == 429:
                    wait_time = (attempt + 1) * 10  # Exponential backoff
                    logger.warning(f"Rate limited, waiting {wait_time}s before retry...")
                    time.sleep(wait_time)
                else:
                    logger.warning(f"Attempt {attempt + 1}/{max_retries} failed: {e}")
                    if attempt < max_retries - 1:
                        time.sleep(2)  # Brief pause before retry

        raise last_error or ClaudeAPIError("All retry attempts failed")

    def close(self) -> None:
        """Close the HTTP client."""
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "OpenRouterClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


class LocalAnalyzer:
    """Local analyzer for debugging without API calls."""

    def __init__(self, thresholds: Optional[ThresholdsConfig] = None) -> None:
        """
        Initialize local analyzer.

        Args:
            thresholds: Threshold configuration for flags
        """
        self.thresholds = thresholds or ThresholdsConfig()

    def analyze(
        self,
        claude_input: Union[ClaudeInput, Dict[str, Any]],
    ) -> str:
        """
        Generate simulated analysis response.

        Args:
            claude_input: Input data

        Returns:
            Simulated response with markdown and CSV
        """
        # Import here to avoid circular imports
        from .profit_calc import calculate_wallet_metrics

        if isinstance(claude_input, dict):
            as_of_date = claude_input.get("as_of_date", datetime.now().strftime("%Y-%m-%d"))
            wallets = claude_input.get("wallets", [])
        else:
            as_of_date = claude_input.as_of_date
            wallets = [w.model_dump(mode="json") for w in claude_input.wallets]

        as_of_dt = datetime.fromisoformat(as_of_date).replace(tzinfo=timezone.utc)
        thresholds_dict = self.thresholds.model_dump()

        wallet_metrics: List[WalletMetrics] = []

        for wallet in wallets:
            wallet_address = wallet.get("wallet_address", "")
            username = wallet.get("username", "")
            trades = wallet.get("trades", [])

            metrics = calculate_wallet_metrics(trades, as_of_dt, thresholds_dict)

            # Convert string flags to WalletFlag enum
            flags = [WalletFlag(f) for f in metrics.get("flags", [])]

            wallet_metrics.append(
                WalletMetrics(
                    wallet_address=wallet_address,
                    username=username,
                    profit_7d=metrics["profit_7d"],
                    total_staked_7d=metrics["total_staked_7d"],
                    roi=metrics["roi"],
                    win_rate=metrics["win_rate"],
                    consistency_score=metrics["consistency_score"],
                    trade_count_7d=metrics["trade_count_7d"],
                    flags=flags,
                )
            )

        # Sort by profit
        wallet_metrics.sort(key=lambda x: x.profit_7d, reverse=True)

        # Generate markdown table
        md_lines = [
            "## Daily Wallet Analysis Report",
            "",
            f"**Analysis Date:** {as_of_date}",
            f"**Wallets Analyzed:** {len(wallet_metrics)}",
            "",
            "| Wallet | Username | Profit_7d | ROI | Win_Rate | Consistency | Flags | Notes |",
            "|--------|----------|-----------|-----|----------|-------------|-------|-------|",
        ]

        csv_lines = [
            "date,wallet_address,username,profit_7d,roi,win_rate,consistency_score,flags"
        ]

        for wm in wallet_metrics:
            wallet_short = (
                f"{wm.wallet_address[:10]}..."
                if len(wm.wallet_address) > 10
                else wm.wallet_address
            )
            profit_str = (
                f"${wm.profit_7d:,.2f}"
                if wm.profit_7d >= 0
                else f"-${abs(wm.profit_7d):,.2f}"
            )
            roi_str = f"{wm.roi * 100:.2f}%"
            win_rate_str = f"{wm.win_rate * 100:.2f}%"

            # Generate notes
            if WalletFlag.SUSPICIOUSLY_ACCURATE in wm.flags:
                notes = "Near-perfect accuracy"
            elif (
                WalletFlag.HIGH_PROFIT in wm.flags
                and WalletFlag.HIGH_CONSISTENCY in wm.flags
            ):
                notes = "Top performer"
            elif WalletFlag.EMERGING in wm.flags:
                notes = "New trader, promising"
            elif wm.profit_7d < 0:
                notes = "Underperforming"
            else:
                notes = "-"

            md_lines.append(
                f"| {wallet_short} | {wm.username} | {profit_str} | {roi_str} | "
                f"{win_rate_str} | {wm.consistency_score} | {wm.flags_str or '-'} | {notes} |"
            )

            csv_lines.append(
                f"{as_of_date},{wm.wallet_address},{wm.username},"
                f"{wm.profit_7d:.2f},{wm.roi:.4f},{wm.win_rate:.4f},"
                f"{wm.consistency_score},{wm.flags_str}"
            )

        response = "\n".join(md_lines) + "\n\n```csv\n" + "\n".join(csv_lines) + "\n```"

        logger.info(f"Generated simulated response for {len(wallet_metrics)} wallets")
        return response


def get_analyzer(
    config: Dict[str, Any],
    local_debug: bool = False,
) -> Union[OpenRouterClient, LocalAnalyzer]:
    """
    Get appropriate analyzer based on configuration.

    Args:
        config: Application configuration
        local_debug: Force local debug mode

    Returns:
        OpenRouterClient or LocalAnalyzer instance
    """
    if local_debug or config.get("LOCAL_DEBUG", False):
        logger.info("Using local analyzer (debug mode)")
        thresholds = ThresholdsConfig(**config.get("thresholds", {}))
        return LocalAnalyzer(thresholds=thresholds)

    llm_config = config.get("openrouter", config.get("claude", {}))
    return OpenRouterClient(
        api_key=llm_config.get("api_key"),
        model=llm_config.get("model", "anthropic/claude-sonnet-4"),
        max_tokens=llm_config.get("max_tokens", 4096),
    )


# Keep backward compatibility alias
ClaudeClient = OpenRouterClient
