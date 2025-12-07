"""
Google Sheets integration for Polymarket Alpha Wallet Tracker.
Uses gspread with service account authentication.
Respects LOCAL_DEBUG mode to skip real API calls.
"""

import json
from pathlib import Path
from typing import Any

try:
    import gspread
    from google.oauth2.service_account import Credentials
    GSPREAD_AVAILABLE = True
except ImportError:
    GSPREAD_AVAILABLE = False
    print("[WARN] gspread not installed. Run: pip install gspread google-auth")


SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]


class SheetsClient:
    """
    Google Sheets client wrapper with LOCAL_DEBUG support.
    """

    def __init__(self, config: dict):
        """
        Initialize the Sheets client.

        Args:
            config: Configuration dictionary with google_sheets settings
        """
        self.config = config
        self.local_debug = config.get("LOCAL_DEBUG", True)
        self.sheets_config = config.get("google_sheets", {})
        self.client = None
        self.spreadsheet = None
        self.worksheet = None

        if not self.local_debug:
            self._initialize_client()

    def _initialize_client(self) -> None:
        """
        Initialize the gspread client with service account credentials.
        """
        if not GSPREAD_AVAILABLE:
            print("[ERROR] gspread is required for Google Sheets integration")
            raise ImportError("gspread not available")

        credentials_path = self.sheets_config.get("credentials_path", "")

        if not credentials_path or not Path(credentials_path).exists():
            print(f"[ERROR] Credentials file not found: {credentials_path}")
            raise FileNotFoundError(f"Credentials file not found: {credentials_path}")

        print(f"[INFO] Loading credentials from: {credentials_path}")

        credentials = Credentials.from_service_account_file(
            credentials_path,
            scopes=SCOPES
        )

        self.client = gspread.authorize(credentials)
        print("[INFO] Successfully authenticated with Google Sheets API")

        spreadsheet_id = self.sheets_config.get("spreadsheet_id", "")
        if not spreadsheet_id:
            print("[ERROR] No spreadsheet_id provided in config")
            raise ValueError("spreadsheet_id is required")

        self.spreadsheet = self.client.open_by_key(spreadsheet_id)
        print(f"[INFO] Opened spreadsheet: {self.spreadsheet.title}")

        worksheet_name = self.sheets_config.get("worksheet_name", "wallets")
        try:
            self.worksheet = self.spreadsheet.worksheet(worksheet_name)
            print(f"[INFO] Using worksheet: {worksheet_name}")
        except gspread.WorksheetNotFound:
            print(f"[WARN] Worksheet '{worksheet_name}' not found, creating it...")
            self.worksheet = self.spreadsheet.add_worksheet(
                title=worksheet_name,
                rows=1000,
                cols=20
            )
            self._initialize_headers()

    def _initialize_headers(self) -> None:
        """
        Initialize headers in a new worksheet.
        """
        headers = [
            "date",
            "wallet_address",
            "username",
            "profit_7d",
            "roi",
            "win_rate",
            "consistency_score",
            "flags"
        ]
        self.worksheet.update("A1:H1", [headers])
        print("[INFO] Initialized headers in worksheet")

    def append_rows(self, rows: list[list[str]]) -> bool:
        """
        Append rows to the wallets worksheet.

        In LOCAL_DEBUG mode, prints the rows instead of writing to Sheets.

        Args:
            rows: List of rows, where each row is a list of field values
                  First row should be the header row

        Returns:
            True if successful, False otherwise
        """
        if not rows:
            print("[WARN] No rows to append")
            return False

        if self.local_debug:
            print("\n" + "=" * 60)
            print("[LOCAL_DEBUG] Would append the following rows to Google Sheets:")
            print("=" * 60)
            for i, row in enumerate(rows):
                row_type = "HEADER" if i == 0 else f"ROW {i}"
                print(f"  [{row_type}] {row}")
            print("=" * 60 + "\n")
            return True

        try:
            data_rows = rows[1:] if len(rows) > 1 else []

            if not data_rows:
                print("[WARN] Only header row provided, no data to append")
                return True

            self.worksheet.append_rows(
                data_rows,
                value_input_option="USER_ENTERED"
            )

            print(f"[INFO] Successfully appended {len(data_rows)} rows to Google Sheets")
            return True

        except Exception as e:
            print(f"[ERROR] Failed to append rows: {e}")
            return False

    def get_all_data(self) -> list[list[str]]:
        """
        Retrieve all data from the worksheet.

        Returns:
            List of all rows in the worksheet
        """
        if self.local_debug:
            print("[LOCAL_DEBUG] get_all_data() called in debug mode")
            return []

        try:
            return self.worksheet.get_all_values()
        except Exception as e:
            print(f"[ERROR] Failed to get data: {e}")
            return []

    def clear_data_rows(self) -> bool:
        """
        Clear all data rows (keeping headers).

        Returns:
            True if successful, False otherwise
        """
        if self.local_debug:
            print("[LOCAL_DEBUG] clear_data_rows() called in debug mode")
            return True

        try:
            last_row = len(self.worksheet.get_all_values())
            if last_row > 1:
                self.worksheet.delete_rows(2, last_row)
                print(f"[INFO] Cleared rows 2 to {last_row}")
            return True
        except Exception as e:
            print(f"[ERROR] Failed to clear data: {e}")
            return False


def load_config(config_path: str = "config.json") -> dict:
    """
    Load configuration from JSON file.

    Args:
        config_path: Path to config file

    Returns:
        Configuration dictionary
    """
    config_file = Path(config_path)

    if not config_file.exists():
        print(f"[WARN] Config file not found: {config_path}")
        print("[WARN] Using default LOCAL_DEBUG configuration")
        return {"LOCAL_DEBUG": True}

    with open(config_file, "r") as f:
        config = json.load(f)

    print(f"[INFO] Loaded config from: {config_path}")
    print(f"[INFO] LOCAL_DEBUG mode: {config.get('LOCAL_DEBUG', True)}")

    return config


def csv_rows_to_sheets_format(parsed_rows: list[list[str]]) -> list[list[str]]:
    """
    Convert parsed CSV rows to the format expected by Sheets.
    Ensures proper data types and formatting.

    Args:
        parsed_rows: List of parsed CSV rows

    Returns:
        Formatted rows ready for Google Sheets
    """
    formatted = []

    for row in parsed_rows:
        formatted_row = [str(cell).strip() for cell in row]
        formatted.append(formatted_row)

    return formatted


if __name__ == "__main__":
    test_config = {
        "LOCAL_DEBUG": True,
        "google_sheets": {
            "credentials_path": "./credentials/service_account.json",
            "spreadsheet_id": "test_spreadsheet_id",
            "worksheet_name": "wallets"
        }
    }

    print("Testing SheetsClient in LOCAL_DEBUG mode:")
    client = SheetsClient(test_config)

    test_rows = [
        ["date", "wallet_address", "username", "profit_7d", "roi", "win_rate", "consistency_score", "flags"],
        ["2025-01-02", "0xabc123", "trader1", "500.00", "0.25", "0.75", "85", "HighProfit|HighConsistency"],
        ["2025-01-02", "0xdef456", "trader2", "150.00", "0.10", "0.60", "65", ""],
        ["2025-01-02", "0xghi789", "trader3", "1200.00", "0.40", "0.95", "92", "HighProfit|SuspiciouslyAccurate"],
    ]

    success = client.append_rows(test_rows)
    print(f"\nAppend result: {'Success' if success else 'Failed'}")
