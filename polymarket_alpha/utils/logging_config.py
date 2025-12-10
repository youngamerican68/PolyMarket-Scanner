"""
Logging configuration for Polymarket Alpha Wallet Tracker.
Provides structured logging with rich console output.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from rich.console import Console
    from rich.logging import RichHandler
    from rich.theme import Theme

    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False


# Custom theme for consistent styling
CUSTOM_THEME = Theme(
    {
        "info": "cyan",
        "warning": "yellow",
        "error": "bold red",
        "success": "bold green",
        "debug": "dim",
        "step": "bold magenta",
        "wallet": "blue",
        "metric": "green",
    }
)

# Global console instance
console = Console(theme=CUSTOM_THEME) if RICH_AVAILABLE else None


class ColoredFormatter(logging.Formatter):
    """Fallback colored formatter when rich is not available."""

    COLORS = {
        "DEBUG": "\033[0;37m",  # Light gray
        "INFO": "\033[0;36m",  # Cyan
        "WARNING": "\033[0;33m",  # Yellow
        "ERROR": "\033[0;31m",  # Red
        "CRITICAL": "\033[1;31m",  # Bold red
    }
    RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        color = self.COLORS.get(record.levelname, self.RESET)
        record.levelname = f"{color}{record.levelname}{self.RESET}"
        return super().format(record)


def setup_logging(
    level: int = logging.INFO,
    log_file: Optional[str] = None,
    debug_mode: bool = False,
) -> logging.Logger:
    """
    Configure logging for the application.

    Args:
        level: Logging level (default: INFO)
        log_file: Optional path to log file
        debug_mode: Enable debug-level logging

    Returns:
        Configured logger instance
    """
    if debug_mode:
        level = logging.DEBUG

    # Get root logger for the package
    logger = logging.getLogger("polymarket_alpha")
    logger.setLevel(level)

    # Remove existing handlers
    logger.handlers.clear()

    # Console handler with rich formatting (if available)
    if RICH_AVAILABLE:
        console_handler = RichHandler(
            console=console,
            show_time=True,
            show_path=False,
            rich_tracebacks=True,
            tracebacks_show_locals=debug_mode,
            markup=True,
        )
        console_handler.setLevel(level)
        logger.addHandler(console_handler)
    else:
        # Fallback to standard logging with colors
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(level)
        formatter = ColoredFormatter(
            "%(asctime)s | %(levelname)s | %(name)s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)

    # File handler (if specified)
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)  # Always debug level for file
        file_formatter = logging.Formatter(
            "%(asctime)s | %(levelname)s | %(name)s | %(funcName)s:%(lineno)d | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        file_handler.setFormatter(file_formatter)
        logger.addHandler(file_handler)

    return logger


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger for a specific module.

    Args:
        name: Module name (typically __name__)

    Returns:
        Logger instance
    """
    return logging.getLogger(f"polymarket_alpha.{name}")


class LogContext:
    """Context manager for logging with additional context."""

    def __init__(self, logger: logging.Logger, context: Dict[str, Any]) -> None:
        self.logger = logger
        self.context = context
        self._old_factory: Any = None

    def __enter__(self) -> logging.Logger:
        self._old_factory = logging.getLogRecordFactory()

        def factory(
            *args: Any, **kwargs: Any
        ) -> logging.LogRecord:
            record = self._old_factory(*args, **kwargs)
            for key, value in self.context.items():
                setattr(record, key, value)
            return record

        logging.setLogRecordFactory(factory)
        return self.logger

    def __exit__(self, *args: Any) -> None:
        logging.setLogRecordFactory(self._old_factory)


# Pipeline step logging helpers
def log_step(logger: logging.Logger, step_number: int, step_name: str) -> None:
    """Log a pipeline step header."""
    if RICH_AVAILABLE and console:
        console.rule(f"[step]Step {step_number}: {step_name}[/step]")
    else:
        logger.info(f"--- Step {step_number}: {step_name} ---")


def log_success(logger: logging.Logger, message: str) -> None:
    """Log a success message."""
    if RICH_AVAILABLE and console:
        console.print(f"[success]✓[/success] {message}")
    else:
        logger.info(f"✓ {message}")


def log_wallet_info(
    logger: logging.Logger,
    wallet: str,
    metrics: Dict[str, Any],
) -> None:
    """Log wallet metrics in a formatted way."""
    wallet_short = f"{wallet[:10]}..." if len(wallet) > 10 else wallet
    profit = metrics.get("profit_7d", 0)
    win_rate = metrics.get("win_rate", 0) * 100
    flags = metrics.get("flags", [])

    if RICH_AVAILABLE and console:
        console.print(
            f"  [wallet]{wallet_short}[/wallet] | "
            f"Profit: [metric]${profit:,.2f}[/metric] | "
            f"Win Rate: [metric]{win_rate:.1f}%[/metric] | "
            f"Flags: {', '.join(flags) if flags else 'None'}"
        )
    else:
        logger.info(
            f"  {wallet_short} | Profit: ${profit:,.2f} | "
            f"Win Rate: {win_rate:.1f}% | Flags: {', '.join(flags) if flags else 'None'}"
        )


def print_banner(title: str, subtitle: Optional[str] = None) -> None:
    """Print a styled banner."""
    if RICH_AVAILABLE and console:
        console.print()
        console.rule(f"[bold cyan]{title}[/bold cyan]", style="cyan")
        if subtitle:
            console.print(f"[dim]{subtitle}[/dim]", justify="center")
        console.print()
    else:
        print()
        print("=" * 60)
        print(f"  {title}")
        if subtitle:
            print(f"  {subtitle}")
        print("=" * 60)
        print()
