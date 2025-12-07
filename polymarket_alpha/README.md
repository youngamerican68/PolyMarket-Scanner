# Polymarket Alpha Wallet Tracker

A complete end-to-end automation system for tracking and analyzing Polymarket traders, calculating profitability metrics, identifying high-signal wallets, and generating daily reports.

## Overview

This system:
1. **Scrapes** top Polymarket traders daily (via Manus CV agent)
2. **Collects** each wallet's trading activity (via Manus CV agent)
3. **Calculates** profitability, ROI, win rate, and consistency scores
4. **Identifies** high-signal or insider-like wallets using rule-based flags
5. **Appends** results to a Google Sheet for tracking
6. **Produces** a daily Markdown report for notifications

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MANUS AUTOMATIONS                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step A: Scrape Top Traders                                      │
│  ─────────────────────────                                       │
│  Manus CV visits: https://polymarket.com/traders                 │
│  Output: ./data/top_traders.json                                 │
│                                                                  │
│                          ↓                                       │
│                                                                  │
│  Step B: Scrape Wallet Activities                                │
│  ────────────────────────────────                                │
│  For each wallet, Manus CV visits:                               │
│  https://polymarket.com/@{username}?tab=activity                 │
│  Output: ./data/wallet_activity_{wallet}.json                    │
│                                                                  │
│                          ↓                                       │
│                                                                  │
│  Step C: Python Pipeline (main_runner.py)                        │
│  ─────────────────────────────────────────                       │
│  1. Load and normalize trader data                               │
│  2. Load and normalize activity data                             │
│  3. Bundle into Claude-ready JSON                                │
│                                                                  │
│                          ↓                                       │
│                                                                  │
│  Step D: Claude Analysis                                         │
│  ───────────────────────                                         │
│  Input: Wallet JSON + Claude_Wallet_Analysis_Prompt.md           │
│  Output: Markdown table + CSV data                               │
│                                                                  │
│                          ↓                                       │
│                                                                  │
│  Step E: Results & Notifications                                 │
│  ───────────────────────────────                                 │
│  1. Append CSV rows to Google Sheets (wallets!A:H)               │
│  2. Save Markdown report for email/Slack/Notion                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Folder Structure

```
/polymarket_alpha/
    ├── README.md
    ├── config.example.json
    ├── main_runner.py
    ├── .gitignore
    ├── utils/
    │       ├── __init__.py
    │       ├── sheets.py
    │       ├── profit_calc.py
    │       └── normalize.py
    ├── scraping/
    │       ├── __init__.py
    │       ├── get_top_traders.py
    │       └── get_wallet_activity.py
    ├── examples/
    │       ├── sample_trader_list.json
    │       └── sample_wallet_activity.json
    ├── prompts/
    │       └── Claude_Wallet_Analysis_Prompt.md
    ├── credentials/
    ├── data/
    │       └── .gitkeep
    └── output/
            └── .gitkeep
```

The `credentials/` directory is for local Google service account files and must be gitignored.

The `.gitkeep` files in `data/` and `output/` are empty placeholders so those runtime directories exist in version control.

The `.gitignore` file should at minimum ignore:
- `config.json`
- the contents of `credentials/` (e.g. `credentials/*`) but keep `credentials/.gitkeep`
- the contents of `data/` and `output/` (e.g. `data/*`, `output/*`) but keep their `.gitkeep` files
- common virtualenv directories (`venv/`, `.venv/`, `env/`, `.virtualenv/`, etc.)

## Quick Start

### 1. Prerequisites

- Python 3.10+
- Google Cloud service account with Sheets API access
- Manus automations configured (or use LOCAL_DEBUG mode)

### 2. Install Dependencies

```bash
pip install gspread google-auth
```

### 3. Configure the Application

```bash
# Copy the example config
cp config.example.json config.json

# Edit config.json with your settings
```

### 4. Run in Debug Mode

```bash
# Test with sample data (no external API calls)
python main_runner.py --debug
```

### 5. Run in Production Mode

```bash
# Requires: Manus JSON files in ./data/ and valid Google credentials
python main_runner.py --config config.json
```

## Configuration

### config.json Structure

```json
{
    "LOCAL_DEBUG": true,          // Set to false for production
    "google_sheets": {
        "credentials_path": "./credentials/service_account.json",
        "spreadsheet_id": "YOUR_SPREADSHEET_ID_HERE",
        "worksheet_name": "wallets",
        "data_range": "A:H"
    },
    "data_paths": {
        "top_traders": "./data/top_traders.json",
        "wallet_activity_dir": "./data/",
        "wallet_activity_pattern": "wallet_activity_{wallet}.json"
    },
    "thresholds": {
        "high_profit_usd": 500.0,
        "high_consistency_score": 80,
        "min_trades_for_emerging": 3,
        "min_trades_for_suspicious": 10,
        "suspicious_win_rate": 0.95
    }
}
```

### LOCAL_DEBUG Mode

When `LOCAL_DEBUG` is `true`:
- Uses sample files from `./examples/` instead of `./data/`
- Skips real Google Sheets API calls (prints rows instead)
- Simulates Claude response with actual metric calculations
- Perfect for testing without external dependencies

## Google Sheets Setup

### 1. Create the Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Create a new spreadsheet named "Polymarket Wallet Tracker"
3. Rename the first sheet to "wallets"
4. Copy the spreadsheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_HERE/edit
   ```

### 2. Set Up Headers

In the `wallets` sheet, add these headers in row 1:

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| date | wallet_address | username | profit_7d | roi | win_rate | consistency_score | flags |

### 3. Create a Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable the Google Sheets API
4. Go to "IAM & Admin" → "Service Accounts"
5. Create a service account
6. Create and download a JSON key
7. Save as `./credentials/service_account.json`

### 4. Share the Spreadsheet

1. Open your spreadsheet
2. Click "Share"
3. Add the service account email (from the JSON key file)
4. Give "Editor" access

### 5. Dashboard Layout Recommendations

#### Filters

1. Select the header row (A1:H1)
2. Go to Data → Create a filter
3. Recommended filter views:
   - **Today's wallets**: Filter by today's date
   - **High performers**: Filter flags contains "HighProfit"
   - **Suspicious activity**: Filter flags contains "SuspiciouslyAccurate"

#### Conditional Formatting

Apply these rules for visual insights:

1. **Profit Color Scale** (Column D - profit_7d):
   - Select D2:D1000
   - Format → Conditional formatting
   - Color scale: Red (min) → White (mid) → Green (max)

2. **ROI Color Scale** (Column E - roi):
   - Select E2:E1000
   - Color scale: Red (negative) → White (0) → Green (positive)

3. **High Consistency Highlight** (Column G - consistency_score):
   - Select G2:G1000
   - Custom formula: `=G2>=80`
   - Format: Bold, green text

4. **Suspicious Wallets Alert** (Column H - flags):
   - Select A2:H1000
   - Custom formula: `=REGEXMATCH($H2,"SuspiciouslyAccurate")`
   - Format: Yellow background, red text

5. **HighProfit Badge** (Column H):
   - Select H2:H1000
   - Text contains: "HighProfit"
   - Format: Green background

## Manus Automations Setup

### Task 1: Scrape Top Traders

Create a Manus CV task:

**Name**: `Polymarket - Scrape Top Traders`

**URL**: `https://polymarket.com/traders`

**Instructions**:
```
Visit the Polymarket traders page. Extract all visible trader information:
- Wallet address (if visible)
- Username
- 24-hour trading volume in USD
- Profile URL

Save as JSON array with this structure:
[
  {
    "wallet_address": "0x...",
    "username": "trader_name",
    "volume_24h_usd": 12345.67,
    "profile_url": "https://polymarket.com/@trader_name"
  }
]
```

**Output**: Save to `./data/top_traders.json`

### Task 2: Scrape Wallet Activity

Create a Manus CV task (runs for each wallet):

**Name**: `Polymarket - Scrape Wallet Activity`

**URL Template**: `https://polymarket.com/@{{username}}?tab=activity`

**Instructions**:
```
Visit the wallet's activity page. Extract all trading activity:
- Transaction type (Buy, Sell, Redeem)
- Market name/question
- Amount in USD
- Timestamp
- Resolved outcome (Yes, No, or null if pending)
- Payout amount in USD

Save as JSON array with this structure:
[
  {
    "type": "Buy",
    "market_name": "Will X happen?",
    "amount_usd": 150.0,
    "timestamp": "2025-01-02T13:45:00Z",
    "resolved_outcome": "Yes",
    "payout_usd": 220.0
  }
]
```

**Output**: Save to `./data/wallet_activity_{{wallet}}.json`

### Task 3: Run Python Pipeline

Create a Manus shell task:

**Name**: `Polymarket - Run Analysis Pipeline`

**Command**:
```bash
cd /path/to/polymarket_alpha && python main_runner.py --config config.json
```

### Task 4: Claude Analysis

Create a Manus Claude task:

**Name**: `Polymarket - Claude Analysis`

**Prompt File**: Use content from `./prompts/Claude_Wallet_Analysis_Prompt.md`

**Variable**: Replace `{{wallet_json}}` with the JSON prepared by the Python pipeline

**Capture Output**: Save both Markdown and CSV portions for subsequent steps

### Task 5: Send Notifications

Create notification tasks for:
- Email: Send Markdown report
- Slack: Post to #polymarket-alpha channel
- Notion: Create daily log entry

## Scheduling Daily Runs

### Using Manus Schedules

1. Create a Schedule in Manus
2. Set to run daily at your preferred time (e.g., 6:00 AM UTC)
3. Chain tasks in order:
   - Scrape Top Traders
   - Scrape Wallet Activity (parallel, one per wallet)
   - Run Python Pipeline
   - Claude Analysis
   - Send Notifications

### Using External Cron

If using cron on a Linux server:

```bash
# Edit crontab
crontab -e

# Add daily run at 6:00 AM UTC
0 6 * * * cd /path/to/polymarket_alpha && /usr/bin/python3 main_runner.py >> /var/log/polymarket.log 2>&1
```

## Using Claude with the Prompt

### In Manus Claude Step

1. Copy the contents of `./prompts/Claude_Wallet_Analysis_Prompt.md`
2. In the Manus Claude task, paste as the system prompt
3. Replace `{{wallet_json}}` with the actual JSON data
4. Claude will output:
   - Markdown table (for reports/notifications)
   - CSV block (for Google Sheets)

### Expected Claude Output

Claude produces two sections:

**Section 1: Markdown Table**
```markdown
## Daily Wallet Analysis Report

| Wallet | Username | Profit_7d | ROI | Win_Rate | Consistency | Flags | Notes |
|--------|----------|-----------|-----|----------|-------------|-------|-------|
| 0xABC123de... | whale_trader | $35,000.00 | 38.89% | 100.00% | 100 | HighProfit | Top performer |
```

**Section 2: CSV Block**
```csv
date,wallet_address,username,profit_7d,roi,win_rate,consistency_score,flags
2025-01-02,0xABC123def456,whale_trader,35000.00,0.3889,1.0000,100,HighProfit
```

## Troubleshooting

### Common Issues

#### "Credentials file not found"
- Ensure `./credentials/service_account.json` exists
- Check the path in `config.json` is correct
- Verify the JSON file is valid

#### "No traders loaded"
- Check if `./data/top_traders.json` exists
- Verify Manus saved the file correctly
- Try running with `--debug` to use sample data

#### "gspread not installed"
```bash
pip install gspread google-auth
```

#### "Permission denied" on Google Sheets
- Verify the service account email has Editor access
- Check the spreadsheet ID is correct
- Ensure the worksheet name matches config

#### "Malformed CSV rows"
- The parser logs and skips invalid lines
- Check Claude's output format matches expected structure
- Review `utils/normalize.py` for parsing logic

### Verification Steps

1. **Test sample data loading**:
   ```bash
   python -c "from scraping.get_top_traders import get_top_traders; print(get_top_traders(file_path='./examples/sample_trader_list.json'))"
   ```

2. **Test metric calculations**:
   ```bash
   python utils/profit_calc.py
   ```

3. **Test CSV parsing**:
   ```bash
   python utils/normalize.py
   ```

4. **Test Sheets client (debug mode)**:
   ```bash
   python utils/sheets.py
   ```

5. **Full pipeline test**:
   ```bash
   python main_runner.py --debug
   ```

## Metrics Reference

### profit_7d
Net profit/loss over 7 days in USD. Calculated from resolved trades only.

### roi
Return on Investment = profit_7d / total_staked_7d. Expressed as decimal.

### win_rate
Winning trades / Total resolved trades. Range: 0.0 to 1.0.

### consistency_score
Composite score (0-100) based on:
- Win rate (40% weight)
- Trade volume (30% weight)
- Profitability (30% weight)

### Flags

| Flag | Condition |
|------|-----------|
| HighProfit | profit_7d >= $500 |
| HighConsistency | consistency_score >= 80 AND trades >= 5 |
| Emerging | 3-9 trades, win_rate >= 70%, profitable |
| SuspiciouslyAccurate | trades >= 10 AND win_rate >= 95% |

## License

MIT License - See LICENSE file for details.
