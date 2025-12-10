#!/usr/bin/env python3
"""
Enhanced CLI for Polymarket Alpha Wallet Tracker.
Provides rich console output and improved user experience.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
    from rich.table import Table
    from rich.theme import Theme

    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False

from utils.logging_config import setup_logging, get_logger, print_banner
from utils.models import AppConfig, WalletMetrics, WalletFlag
from utils.exceptions import PipelineError, ConfigurationError


# Custom theme
THEME = Theme({
    "info": "cyan",
    "success": "bold green",
    "warning": "bold yellow",
    "error": "bold red",
    "profit_positive": "green",
    "profit_negative": "red",
    "flag": "magenta",
})

console = Console(theme=THEME) if RICH_AVAILABLE else None


def create_metrics_table(
    metrics: list[dict[str, Any]],
    as_of_date: str,
) -> Table | None:
    """Create a rich table for wallet metrics."""
    if not RICH_AVAILABLE:
        return None

    table = Table(
        title=f"Wallet Analysis - {as_of_date}",
        show_header=True,
        header_style="bold cyan",
    )

    table.add_column("Wallet", style="dim", width=14)
    table.add_column("Username", width=16)
    table.add_column("Profit 7d", justify="right", width=12)
    table.add_column("ROI", justify="right", width=8)
    table.add_column("Win Rate", justify="right", width=10)
    table.add_column("Score", justify="center", width=6)
    table.add_column("Flags", width=25)

    for m in metrics:
        wallet = m.get("wallet_address", "")[:12] + "..."
        username = m.get("username", "")[:15]
        profit = m.get("profit_7d", 0)
        roi = m.get("roi", 0) * 100
        win_rate = m.get("win_rate", 0) * 100
        score = m.get("consistency_score", 0)
        flags = m.get("flags", [])

        # Style profit based on positive/negative
        profit_style = "profit_positive" if profit >= 0 else "profit_negative"
        profit_str = f"${profit:,.2f}" if profit >= 0 else f"-${abs(profit):,.2f}"

        # Style flags
        flags_str = " ".join(f"[flag]{f}[/flag]" for f in flags) if flags else "-"

        table.add_row(
            wallet,
            username,
            f"[{profit_style}]{profit_str}[/{profit_style}]",
            f"{roi:.1f}%",
            f"{win_rate:.1f}%",
            str(score),
            flags_str,
        )

    return table


def run_with_progress(config: AppConfig, logger: Any) -> bool:
    """Run the pipeline with progress indicators."""
    from main_runner import (
        load_prompt_template,
        prepare_claude_input,
        process_claude_response,
        save_markdown_report,
    )
    from scraping.get_top_traders import get_top_traders
    from utils.sheets import SheetsClient, csv_rows_to_sheets_format
    from utils.claude_client import get_analyzer

    config_dict = config.model_dump() if hasattr(config, "model_dump") else dict(config)

    if not RICH_AVAILABLE:
        # Fallback to simple progress
        return run_pipeline_simple(config_dict, logger)

    steps = [
        ("Loading traders", "traders"),
        ("Preparing data", "data"),
        ("Loading prompt", "prompt"),
        ("Analyzing wallets", "analysis"),
        ("Processing results", "results"),
        ("Saving to sheets", "sheets"),
        ("Saving report", "report"),
    ]

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Running pipeline...", total=len(steps))

        try:
            # Step 1: Load traders
            progress.update(task, description="Loading traders...")
            if config.LOCAL_DEBUG:
                sample_path = config.example_paths.get(
                    "sample_traders", "./examples/sample_trader_list.json"
                )
                traders = get_top_traders(file_path=sample_path, config=config_dict)
            else:
                traders = get_top_traders(config=config_dict)

            if not traders:
                raise PipelineError("Loading traders", "No traders loaded")
            progress.advance(task)

            # Step 2: Prepare Claude input
            progress.update(task, description="Preparing data...")
            claude_input = prepare_claude_input(traders, config_dict)
            if not claude_input.get("wallets"):
                raise PipelineError("Preparing data", "No wallet data")
            progress.advance(task)

            # Step 3: Load prompt
            progress.update(task, description="Loading prompt...")
            prompt_template = load_prompt_template(config_dict)
            if not prompt_template:
                raise PipelineError("Loading prompt", "No prompt template")
            progress.advance(task)

            # Step 4: Analyze with Claude
            progress.update(task, description="Analyzing wallets...")
            analyzer = get_analyzer(config_dict, config.LOCAL_DEBUG)

            if hasattr(analyzer, "analyze"):
                response = analyzer.analyze(claude_input)
            else:
                response = ""

            progress.advance(task)

            # Step 5: Process results
            progress.update(task, description="Processing results...")
            markdown_report, csv_rows = process_claude_response(response, config_dict)
            progress.advance(task)

            # Step 6: Save to sheets
            progress.update(task, description="Saving to sheets...")
            sheets_client = SheetsClient(config_dict)
            if csv_rows:
                formatted_rows = csv_rows_to_sheets_format(csv_rows)
                sheets_client.append_rows(formatted_rows)
            progress.advance(task)

            # Step 7: Save report
            progress.update(task, description="Saving report...")
            if markdown_report:
                save_markdown_report(markdown_report, config_dict)
            progress.advance(task)

            return True

        except PipelineError as e:
            console.print(f"[error]Pipeline failed: {e}[/error]")
            return False
        except Exception as e:
            console.print(f"[error]Unexpected error: {e}[/error]")
            return False


def run_pipeline_simple(config: dict[str, Any], logger: Any) -> bool:
    """Run the pipeline without rich progress (fallback)."""
    from main_runner import run_pipeline as original_run_pipeline

    # Create a temporary config file
    config_path = Path("config_cli_temp.json")
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2, default=str)

    try:
        return original_run_pipeline(str(config_path))
    finally:
        if config_path.exists():
            config_path.unlink()


def display_summary(metrics: list[dict[str, Any]], as_of_date: str) -> None:
    """Display summary statistics."""
    if not metrics:
        return

    if not RICH_AVAILABLE:
        print(f"\n=== Summary ({len(metrics)} wallets) ===")
        return

    total_profit = sum(m.get("profit_7d", 0) for m in metrics)
    avg_win_rate = sum(m.get("win_rate", 0) for m in metrics) / len(metrics) if metrics else 0
    high_profit_count = sum(1 for m in metrics if "HighProfit" in m.get("flags", []))
    suspicious_count = sum(1 for m in metrics if "SuspiciouslyAccurate" in m.get("flags", []))

    summary_panel = Panel(
        f"""
[bold]Wallets Analyzed:[/bold] {len(metrics)}
[bold]Total Profit (7d):[/bold] {'[profit_positive]' if total_profit >= 0 else '[profit_negative]'}${abs(total_profit):,.2f}{'[/profit_positive]' if total_profit >= 0 else '[/profit_negative]'}
[bold]Avg Win Rate:[/bold] {avg_win_rate * 100:.1f}%
[bold]High Profit Wallets:[/bold] {high_profit_count}
[bold]Suspicious Wallets:[/bold] {suspicious_count}
        """.strip(),
        title="Analysis Summary",
        border_style="cyan",
    )
    console.print(summary_panel)


def main() -> int:
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Polymarket Alpha Wallet Tracker - Automated Trading Analytics",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                      Run with default config
  %(prog)s --debug              Run in local debug mode
  %(prog)s --config my_config.json  Use custom config file
  %(prog)s --verbose            Show detailed logs
        """,
    )

    parser.add_argument(
        "--config",
        type=str,
        default="config.json",
        help="Path to configuration file (default: config.json)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Force LOCAL_DEBUG mode",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress non-essential output",
    )
    parser.add_argument(
        "--version",
        action="version",
        version="%(prog)s 1.0.0",
    )

    args = parser.parse_args()

    # Setup logging
    import logging
    log_level = logging.DEBUG if args.verbose else (logging.WARNING if args.quiet else logging.INFO)
    logger = setup_logging(level=log_level, debug_mode=args.debug)

    # Print banner
    if not args.quiet:
        print_banner(
            "POLYMARKET ALPHA WALLET TRACKER",
            f"Analysis Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        )

    # Load configuration
    config_path = Path(args.config)
    if not config_path.exists():
        if RICH_AVAILABLE and console:
            console.print(f"[warning]Config file not found: {args.config}[/warning]")
            console.print("[info]Using default debug configuration[/info]")
        else:
            print(f"Config file not found: {args.config}, using defaults")

        config = AppConfig(LOCAL_DEBUG=True)
    else:
        try:
            with open(config_path) as f:
                config_data = json.load(f)
            config = AppConfig.from_dict(config_data)
        except Exception as e:
            if RICH_AVAILABLE and console:
                console.print(f"[error]Failed to load config: {e}[/error]")
            else:
                print(f"Failed to load config: {e}")
            return 1

    # Override debug mode if specified
    if args.debug:
        config.LOCAL_DEBUG = True

    # Run pipeline
    mode = "LOCAL_DEBUG" if config.LOCAL_DEBUG else "PRODUCTION"
    if not args.quiet:
        if RICH_AVAILABLE and console:
            console.print(f"[info]Running in {mode} mode[/info]\n")
        else:
            print(f"Running in {mode} mode\n")

    success = run_with_progress(config, logger)

    # Print result
    if not args.quiet:
        if RICH_AVAILABLE and console:
            if success:
                console.print("\n[success]Pipeline completed successfully![/success]")
            else:
                console.print("\n[error]Pipeline failed![/error]")
        else:
            if success:
                print("\nPipeline completed successfully!")
            else:
                print("\nPipeline failed!")

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
