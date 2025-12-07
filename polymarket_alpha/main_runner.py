#!/usr/bin/env python3
"""
Polymarket Alpha Wallet Tracker - Main Runner

This is the single entry point for the daily run pipeline.
Orchestrates the full workflow:
1. Load trader list from Manus JSON output
2. Load wallet activity data for each trader
3. Bundle data for Claude analysis
4. Process Claude's response (Markdown + CSV)
5. Append results to Google Sheets
6. Save/output the Markdown report for notifications

Usage:
    python main_runner.py [--config path/to/config.json]

Environment:
    - Set LOCAL_DEBUG=true in config to run in debug mode
    - In debug mode, uses sample files and skips real API calls
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))

from scraping.get_top_traders import get_top_traders, get_wallet_identifiers
from scraping.get_wallet_activity import (
    get_wallet_activity,
    get_activity_file_path,
    build_wallet_data_for_claude
)
from utils.normalize import (
    build_claude_input_json,
    parse_claude_csv_output,
    extract_csv_block_from_claude_response,
    extract_markdown_block_from_claude_response
)
from utils.sheets import SheetsClient, load_config, csv_rows_to_sheets_format
from utils.profit_calc import calculate_wallet_metrics


def load_prompt_template(config: dict) -> str:
    """
    Load the Claude prompt template from file.

    Args:
        config: Configuration dictionary

    Returns:
        Prompt template string
    """
    prompt_path = config.get("claude", {}).get(
        "prompt_path",
        "./prompts/Claude_Wallet_Analysis_Prompt.md"
    )

    try:
        with open(prompt_path, "r", encoding="utf-8") as f:
            template = f.read()
        print(f"[INFO] Loaded prompt template from: {prompt_path}")
        return template
    except FileNotFoundError:
        print(f"[ERROR] Prompt template not found: {prompt_path}")
        return ""


def prepare_claude_input(traders: list[dict], config: dict) -> dict:
    """
    Prepare the full JSON input for Claude analysis.

    Args:
        traders: List of normalized trader dictionaries
        config: Configuration dictionary

    Returns:
        JSON-serializable dictionary for Claude
    """
    local_debug = config.get("LOCAL_DEBUG", False)
    as_of_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    wallets_data = []

    if local_debug:
        sample_path = config.get("example_paths", {}).get(
            "sample_activity",
            "./examples/sample_wallet_activity.json"
        )
        print(f"[LOCAL_DEBUG] Loading sample activity from: {sample_path}")

        try:
            with open(sample_path, "r", encoding="utf-8") as f:
                sample_data = json.load(f)

            if "wallets" in sample_data:
                for wallet_data in sample_data["wallets"]:
                    wallets_data.append({
                        "wallet_address": wallet_data.get("wallet_address", ""),
                        "username": wallet_data.get("username", ""),
                        "trades": wallet_data.get("activities", [])
                    })
            else:
                print("[WARN] Sample activity file has unexpected structure")

        except Exception as e:
            print(f"[ERROR] Failed to load sample activity: {e}")
    else:
        for trader in traders:
            wallet = trader.get("wallet_address", "")
            username = trader.get("username", "")

            activity_path = get_activity_file_path(wallet or username, config)
            trades = get_wallet_activity(wallet or username, file_path=activity_path)

            wallets_data.append({
                "wallet_address": wallet,
                "username": username,
                "trades": trades
            })

    claude_input = build_claude_input_json(as_of_date, wallets_data)

    print(f"[INFO] Prepared Claude input with {len(wallets_data)} wallets")
    return claude_input


def call_claude_for_analysis(claude_input: dict, prompt_template: str, config: dict) -> str:
    """
    Call Claude to analyze wallet data.

    In a real implementation, this would call the Claude API.
    Currently simulates the response for local development.

    Args:
        claude_input: JSON input for Claude
        prompt_template: The prompt template with {{wallet_json}} placeholder
        config: Configuration dictionary

    Returns:
        Claude's response text (Markdown + CSV)
    """
    local_debug = config.get("LOCAL_DEBUG", False)

    wallet_json_str = json.dumps(claude_input, indent=2)

    full_prompt = prompt_template.replace("{{wallet_json}}", wallet_json_str)

    if local_debug:
        print("\n" + "=" * 60)
        print("[LOCAL_DEBUG] Claude Analysis Simulation")
        print("=" * 60)
        print("[INFO] In production, this prompt would be sent to Claude:")
        print(f"[INFO] Input contains {len(claude_input.get('wallets', []))} wallets")
        print(f"[INFO] as_of_date: {claude_input.get('as_of_date')}")
        print("=" * 60)

        simulated_response = generate_simulated_response(claude_input, config)
        return simulated_response

    print("[INFO] Claude API call would be made here")
    print("[INFO] Prompt prepared with wallet data")

    return ""


def generate_simulated_response(claude_input: dict, config: dict) -> str:
    """
    Generate a simulated Claude response for local debugging.

    This function calculates actual metrics using the profit_calc module
    to provide realistic output for testing.

    Args:
        claude_input: JSON input for Claude
        config: Configuration dictionary

    Returns:
        Simulated response with Markdown table and CSV
    """
    as_of_date = claude_input.get("as_of_date", datetime.now().strftime("%Y-%m-%d"))
    wallets = claude_input.get("wallets", [])

    thresholds = config.get("thresholds", {
        "high_profit_usd": 500.0,
        "high_consistency_score": 80,
        "min_trades_for_emerging": 3,
        "min_trades_for_suspicious": 10,
        "suspicious_win_rate": 0.95
    })

    as_of_dt = datetime.fromisoformat(as_of_date).replace(tzinfo=timezone.utc)

    wallet_metrics = []
    for wallet in wallets:
        wallet_address = wallet.get("wallet_address", "")
        username = wallet.get("username", "")
        trades = wallet.get("trades", [])

        metrics = calculate_wallet_metrics(trades, as_of_dt, thresholds)

        wallet_metrics.append({
            "wallet_address": wallet_address,
            "username": username,
            **metrics
        })

    wallet_metrics.sort(key=lambda x: x.get("profit_7d", 0), reverse=True)

    md_lines = [
        "## Daily Wallet Analysis Report",
        "",
        "| Wallet | Username | Profit_7d | ROI | Win_Rate | Consistency | Flags | Notes |",
        "|--------|----------|-----------|-----|----------|-------------|-------|-------|"
    ]

    csv_lines = [
        "date,wallet_address,username,profit_7d,roi,win_rate,consistency_score,flags"
    ]

    for wm in wallet_metrics:
        wallet_short = wm["wallet_address"][:10] + "..." if len(wm["wallet_address"]) > 10 else wm["wallet_address"]
        profit_str = f"${wm['profit_7d']:,.2f}" if wm['profit_7d'] >= 0 else f"-${abs(wm['profit_7d']):,.2f}"
        roi_str = f"{wm['roi'] * 100:.2f}%"
        win_rate_str = f"{wm['win_rate'] * 100:.2f}%"
        flags_str = "|".join(wm["flags"]) if wm["flags"] else "-"

        if "SuspiciouslyAccurate" in wm["flags"]:
            notes = "Near-perfect accuracy"
        elif "HighProfit" in wm["flags"] and "HighConsistency" in wm["flags"]:
            notes = "Top performer"
        elif "Emerging" in wm["flags"]:
            notes = "New trader, promising"
        elif wm["profit_7d"] < 0:
            notes = "Underperforming"
        else:
            notes = "-"

        md_lines.append(
            f"| {wallet_short} | {wm['username']} | {profit_str} | {roi_str} | "
            f"{win_rate_str} | {wm['consistency_score']} | {flags_str} | {notes} |"
        )

        csv_flags = "|".join(wm["flags"]) if wm["flags"] else ""
        csv_lines.append(
            f"{as_of_date},{wm['wallet_address']},{wm['username']},"
            f"{wm['profit_7d']:.2f},{wm['roi']:.4f},{wm['win_rate']:.4f},"
            f"{wm['consistency_score']},{csv_flags}"
        )

    response = "\n".join(md_lines) + "\n\n```csv\n" + "\n".join(csv_lines) + "\n```"

    return response


def process_claude_response(response: str, config: dict) -> tuple[str, list[list[str]]]:
    """
    Process Claude's response to extract Markdown and CSV data.

    Args:
        response: Claude's full response text
        config: Configuration dictionary

    Returns:
        Tuple of (markdown_report, parsed_csv_rows)
    """
    if not response:
        print("[WARN] Empty Claude response")
        return "", []

    markdown_report = extract_markdown_block_from_claude_response(response)
    csv_block = extract_csv_block_from_claude_response(response)

    csv_rows = parse_claude_csv_output(csv_block)

    print(f"[INFO] Extracted markdown report ({len(markdown_report)} chars)")
    print(f"[INFO] Parsed {len(csv_rows)} CSV rows")

    return markdown_report, csv_rows


def save_markdown_report(markdown: str, config: dict) -> str:
    """
    Save the Markdown report to file.

    Args:
        markdown: Markdown report content
        config: Configuration dictionary

    Returns:
        Path to saved file
    """
    output_config = config.get("output", {})
    output_path = output_config.get("markdown_report_path", "./output/daily_report.md")

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        f.write(markdown)

    print(f"[INFO] Saved Markdown report to: {output_path}")
    return output_path


def run_pipeline(config_path: str = "config.json") -> bool:
    """
    Run the full Polymarket wallet analysis pipeline.

    Steps:
    1. Load configuration
    2. Load trader list (from Manus JSON or samples)
    3. Load wallet activity data
    4. Prepare and send data to Claude
    5. Process Claude's response
    6. Append to Google Sheets
    7. Save Markdown report

    Args:
        config_path: Path to configuration file

    Returns:
        True if pipeline completed successfully
    """
    print("\n" + "=" * 60)
    print("  POLYMARKET ALPHA WALLET TRACKER")
    print("  Daily Analysis Pipeline")
    print("=" * 60)

    config = load_config(config_path)
    local_debug = config.get("LOCAL_DEBUG", False)

    print(f"\n[INFO] Running in {'LOCAL_DEBUG' if local_debug else 'PRODUCTION'} mode")
    print(f"[INFO] Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")

    print("\n--- Step 1: Loading Traders ---")
    if local_debug:
        sample_traders_path = config.get("example_paths", {}).get(
            "sample_traders",
            "./examples/sample_trader_list.json"
        )
        traders = get_top_traders(file_path=sample_traders_path, config=config)
    else:
        traders = get_top_traders(config=config)

    if not traders:
        print("[ERROR] No traders loaded. Exiting.")
        return False

    print(f"[INFO] Loaded {len(traders)} traders")

    print("\n--- Step 2: Preparing Claude Input ---")
    claude_input = prepare_claude_input(traders, config)

    if not claude_input.get("wallets"):
        print("[ERROR] No wallet data prepared. Exiting.")
        return False

    print("\n--- Step 3: Loading Prompt Template ---")
    prompt_template = load_prompt_template(config)

    if not prompt_template:
        print("[ERROR] Failed to load prompt template. Exiting.")
        return False

    print("\n--- Step 4: Calling Claude for Analysis ---")
    claude_response = call_claude_for_analysis(claude_input, prompt_template, config)

    if not claude_response:
        print("[WARN] No Claude response. In production, this would fail.")
        if not local_debug:
            return False

    print("\n--- Step 5: Processing Claude Response ---")
    markdown_report, csv_rows = process_claude_response(claude_response, config)

    print("\n--- Step 6: Appending to Google Sheets ---")
    sheets_client = SheetsClient(config)
    if csv_rows:
        formatted_rows = csv_rows_to_sheets_format(csv_rows)
        sheets_client.append_rows(formatted_rows)
    else:
        print("[WARN] No CSV rows to append")

    print("\n--- Step 7: Saving Markdown Report ---")
    if markdown_report:
        report_path = save_markdown_report(markdown_report, config)

        print("\n--- Markdown Report Preview ---")
        print(markdown_report[:1000] + "..." if len(markdown_report) > 1000 else markdown_report)
    else:
        print("[WARN] No markdown report to save")

    print("\n" + "=" * 60)
    print("  PIPELINE COMPLETED SUCCESSFULLY")
    print("=" * 60 + "\n")

    return True


def main():
    """
    Main entry point with command-line argument parsing.
    """
    parser = argparse.ArgumentParser(
        description="Polymarket Alpha Wallet Tracker - Daily Analysis Pipeline"
    )
    parser.add_argument(
        "--config",
        type=str,
        default="config.json",
        help="Path to configuration file (default: config.json)"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Force LOCAL_DEBUG mode regardless of config"
    )

    args = parser.parse_args()

    if args.debug:
        print("[INFO] Forcing LOCAL_DEBUG mode from command line")
        config = load_config(args.config)
        config["LOCAL_DEBUG"] = True

        with open("config_debug.json", "w") as f:
            json.dump(config, f, indent=2)

        success = run_pipeline("config_debug.json")

        os.remove("config_debug.json")
    else:
        success = run_pipeline(args.config)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
