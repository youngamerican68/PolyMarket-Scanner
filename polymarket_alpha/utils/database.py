"""
SQLite database storage for Polymarket Alpha Wallet Tracker.
Free alternative to Google Sheets with powerful querying capabilities.
"""

from __future__ import annotations

import csv
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .logging_config import get_logger

logger = get_logger(__name__)

# Default database path
DEFAULT_DB_PATH = "./data/wallets.db"

# SQL schema
SCHEMA = """
CREATE TABLE IF NOT EXISTS wallet_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    username TEXT,
    profit_7d REAL,
    roi REAL,
    win_rate REAL,
    consistency_score INTEGER,
    flags TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Composite unique constraint to prevent duplicates
    UNIQUE(date, wallet_address)
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_wallet_date ON wallet_metrics(wallet_address, date);
CREATE INDEX IF NOT EXISTS idx_date ON wallet_metrics(date);
CREATE INDEX IF NOT EXISTS idx_flags ON wallet_metrics(flags);
"""


class DatabaseClient:
    """SQLite database client for wallet metrics storage."""

    def __init__(self, db_path: Optional[str] = None, local_debug: bool = False) -> None:
        """
        Initialize the database client.

        Args:
            db_path: Path to SQLite database file
            local_debug: If True, prints operations instead of executing
        """
        self.db_path = db_path or DEFAULT_DB_PATH
        self.local_debug = local_debug
        self._connection: Optional[sqlite3.Connection] = None

        if not local_debug:
            self._initialize_db()

    def _initialize_db(self) -> None:
        """Create database and tables if they don't exist."""
        # Ensure directory exists
        db_file = Path(self.db_path)
        db_file.parent.mkdir(parents=True, exist_ok=True)

        conn = self._get_connection()
        conn.executescript(SCHEMA)
        conn.commit()
        logger.info(f"Database initialized at: {self.db_path}")

    def _get_connection(self) -> sqlite3.Connection:
        """Get or create database connection."""
        if self._connection is None:
            self._connection = sqlite3.connect(self.db_path)
            self._connection.row_factory = sqlite3.Row
        return self._connection

    def close(self) -> None:
        """Close database connection."""
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    def append_rows(self, rows: List[List[str]]) -> bool:
        """
        Append wallet metrics rows to database.

        Compatible with the same interface as SheetsClient.

        Args:
            rows: List of rows where first row is header
                  [date, wallet_address, username, profit_7d, roi, win_rate, consistency_score, flags]

        Returns:
            True if successful
        """
        if not rows:
            logger.warning("No rows to append")
            return False

        if self.local_debug:
            print("\n" + "=" * 60)
            print("[LOCAL_DEBUG] Would insert the following rows to SQLite:")
            print("=" * 60)
            for i, row in enumerate(rows):
                row_type = "HEADER" if i == 0 else f"ROW {i}"
                print(f"  [{row_type}] {row}")
            print("=" * 60 + "\n")
            return True

        # Skip header row
        data_rows = rows[1:] if len(rows) > 1 else []
        if not data_rows:
            logger.warning("Only header row provided, no data to insert")
            return True

        conn = self._get_connection()
        cursor = conn.cursor()

        inserted = 0
        updated = 0

        for row in data_rows:
            if len(row) < 8:
                logger.warning(f"Skipping incomplete row: {row}")
                continue

            try:
                # Use INSERT OR REPLACE to handle duplicates
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO wallet_metrics
                    (date, wallet_address, username, profit_7d, roi, win_rate, consistency_score, flags)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        row[0],  # date
                        row[1],  # wallet_address
                        row[2],  # username
                        float(row[3]) if row[3] else 0.0,  # profit_7d
                        float(row[4]) if row[4] else 0.0,  # roi
                        float(row[5]) if row[5] else 0.0,  # win_rate
                        int(row[6]) if row[6] else 0,  # consistency_score
                        row[7] if len(row) > 7 else "",  # flags
                    ),
                )
                if cursor.rowcount > 0:
                    inserted += 1
            except Exception as e:
                logger.error(f"Failed to insert row {row}: {e}")

        conn.commit()
        logger.info(f"Inserted/updated {inserted} rows in database")
        return True

    def get_wallet_history(
        self,
        wallet_address: str,
        limit: int = 30,
    ) -> List[Dict[str, Any]]:
        """
        Get historical metrics for a specific wallet.

        Args:
            wallet_address: Wallet address to query
            limit: Maximum number of records

        Returns:
            List of metric records
        """
        if self.local_debug:
            return []

        conn = self._get_connection()
        cursor = conn.execute(
            """
            SELECT * FROM wallet_metrics
            WHERE LOWER(wallet_address) = LOWER(?)
            ORDER BY date DESC
            LIMIT ?
            """,
            (wallet_address, limit),
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_flagged_wallets(
        self,
        flag: str,
        days: int = 7,
    ) -> List[Dict[str, Any]]:
        """
        Get wallets with a specific flag in recent days.

        Args:
            flag: Flag to search for (e.g., "SuspiciouslyAccurate")
            days: Number of days to look back

        Returns:
            List of wallet records
        """
        if self.local_debug:
            return []

        conn = self._get_connection()
        cursor = conn.execute(
            """
            SELECT * FROM wallet_metrics
            WHERE flags LIKE ?
            AND date >= date('now', ?)
            ORDER BY date DESC, profit_7d DESC
            """,
            (f"%{flag}%", f"-{days} days"),
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_top_performers(
        self,
        days: int = 7,
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        """
        Get top performing wallets by profit.

        Args:
            days: Number of days to look back
            limit: Maximum number of results

        Returns:
            List of wallet records
        """
        if self.local_debug:
            return []

        conn = self._get_connection()
        cursor = conn.execute(
            """
            SELECT wallet_address, username,
                   AVG(profit_7d) as avg_profit,
                   AVG(win_rate) as avg_win_rate,
                   AVG(consistency_score) as avg_consistency,
                   COUNT(*) as days_tracked
            FROM wallet_metrics
            WHERE date >= date('now', ?)
            GROUP BY wallet_address
            ORDER BY avg_profit DESC
            LIMIT ?
            """,
            (f"-{days} days", limit),
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_all_data(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """
        Get all wallet metrics data.

        Args:
            limit: Maximum number of records

        Returns:
            List of all records
        """
        if self.local_debug:
            return []

        conn = self._get_connection()
        cursor = conn.execute(
            """
            SELECT * FROM wallet_metrics
            ORDER BY date DESC, profit_7d DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in cursor.fetchall()]

    def export_to_csv(self, output_path: str, days: Optional[int] = None) -> bool:
        """
        Export database to CSV file.

        Args:
            output_path: Path for CSV output
            days: Optional filter for recent days only

        Returns:
            True if successful
        """
        if self.local_debug:
            logger.info(f"[LOCAL_DEBUG] Would export to: {output_path}")
            return True

        conn = self._get_connection()

        if days:
            cursor = conn.execute(
                """
                SELECT date, wallet_address, username, profit_7d, roi,
                       win_rate, consistency_score, flags
                FROM wallet_metrics
                WHERE date >= date('now', ?)
                ORDER BY date DESC, profit_7d DESC
                """,
                (f"-{days} days",),
            )
        else:
            cursor = conn.execute(
                """
                SELECT date, wallet_address, username, profit_7d, roi,
                       win_rate, consistency_score, flags
                FROM wallet_metrics
                ORDER BY date DESC, profit_7d DESC
                """
            )

        rows = cursor.fetchall()

        # Write to CSV
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)

        with open(output_file, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([
                "date", "wallet_address", "username", "profit_7d",
                "roi", "win_rate", "consistency_score", "flags"
            ])
            writer.writerows(rows)

        logger.info(f"Exported {len(rows)} rows to: {output_path}")
        return True

    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        if self.local_debug:
            return {"status": "debug_mode"}

        conn = self._get_connection()

        stats = {}

        # Total records
        cursor = conn.execute("SELECT COUNT(*) FROM wallet_metrics")
        stats["total_records"] = cursor.fetchone()[0]

        # Unique wallets
        cursor = conn.execute("SELECT COUNT(DISTINCT wallet_address) FROM wallet_metrics")
        stats["unique_wallets"] = cursor.fetchone()[0]

        # Date range
        cursor = conn.execute("SELECT MIN(date), MAX(date) FROM wallet_metrics")
        row = cursor.fetchone()
        stats["first_date"] = row[0]
        stats["last_date"] = row[1]

        # Flagged counts
        cursor = conn.execute(
            "SELECT COUNT(*) FROM wallet_metrics WHERE flags LIKE '%SuspiciouslyAccurate%'"
        )
        stats["suspicious_count"] = cursor.fetchone()[0]

        cursor = conn.execute(
            "SELECT COUNT(*) FROM wallet_metrics WHERE flags LIKE '%HighProfit%'"
        )
        stats["high_profit_count"] = cursor.fetchone()[0]

        return stats

    def __enter__(self) -> "DatabaseClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


def get_storage_client(config: Dict[str, Any]) -> DatabaseClient:
    """
    Get storage client based on configuration.

    Args:
        config: Application configuration

    Returns:
        DatabaseClient instance
    """
    local_debug = config.get("LOCAL_DEBUG", False)
    db_config = config.get("database", {})
    db_path = db_config.get("path", DEFAULT_DB_PATH)

    return DatabaseClient(db_path=db_path, local_debug=local_debug)
