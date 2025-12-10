"""
Async data loading utilities for Polymarket Alpha Wallet Tracker.
Enables concurrent fetching of wallet activity data for improved performance.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from .exceptions import DataLoadError, InvalidJSONError
from .logging_config import get_logger
from .models import Trade, TradeType, WalletData

logger = get_logger(__name__)


async def load_json_file_async(file_path: Union[str, Path]) -> Union[Dict[str, Any], List[Any]]:
    """
    Asynchronously load a JSON file.

    Args:
        file_path: Path to the JSON file

    Returns:
        Parsed JSON data

    Raises:
        DataLoadError: If file cannot be loaded
        InvalidJSONError: If JSON is invalid
    """
    path = Path(file_path)

    if not path.exists():
        raise DataLoadError(f"File not found: {file_path}", {"file_path": str(file_path)})

    try:
        # Use asyncio to run file I/O in executor
        loop = asyncio.get_event_loop()
        content = await loop.run_in_executor(
            None,
            lambda: path.read_text(encoding="utf-8"),
        )
        return json.loads(content)
    except json.JSONDecodeError as e:
        raise InvalidJSONError(str(file_path), str(e))


async def load_wallet_activity_async(
    wallet_identifier: str,
    data_dir: Union[str, Path],
    pattern: str = "wallet_activity_{wallet}.json",
) -> Optional[WalletData]:
    """
    Asynchronously load activity data for a single wallet.

    Args:
        wallet_identifier: Wallet address or username
        data_dir: Directory containing activity files
        pattern: Filename pattern with {wallet} placeholder

    Returns:
        WalletData if loaded successfully, None otherwise
    """
    # Sanitize wallet identifier for filename
    import re
    sanitized = re.sub(r"[^a-zA-Z0-9]", "_", wallet_identifier)
    if len(sanitized) > 50:
        sanitized = sanitized[:50]

    filename = pattern.format(wallet=sanitized)
    file_path = Path(data_dir) / filename

    try:
        data = await load_json_file_async(file_path)

        # Parse activities from various formats
        if isinstance(data, list):
            raw_activities = data
        elif isinstance(data, dict):
            raw_activities = data.get("activities", data.get("trades", [data]))
        else:
            logger.warning(f"Unexpected data format for {wallet_identifier}")
            return None

        # Convert to Trade objects, filtering allowed types
        trades: List[Trade] = []
        for activity in raw_activities:
            trade_type = activity.get("type", "").strip().capitalize()
            if trade_type not in {t.value for t in TradeType}:
                continue  # Skip non-trade activities

            try:
                trade = Trade(
                    type=TradeType(trade_type),
                    market_name=activity.get("market_name", ""),
                    amount_usd=float(activity.get("amount_usd", 0)),
                    timestamp=activity.get("timestamp", ""),
                    resolved_outcome=activity.get("resolved_outcome"),
                    payout_usd=float(activity.get("payout_usd", 0)),
                )
                trades.append(trade)
            except Exception as e:
                logger.debug(f"Skipping invalid trade: {e}")

        return WalletData(
            wallet_address=wallet_identifier,
            username="",  # Will be filled in from trader data
            trades=trades,
        )

    except (DataLoadError, InvalidJSONError) as e:
        logger.warning(f"Could not load activity for {wallet_identifier}: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error loading {wallet_identifier}: {e}")
        return None


async def load_all_wallet_activities_async(
    wallet_identifiers: List[str],
    data_dir: Union[str, Path],
    pattern: str = "wallet_activity_{wallet}.json",
    max_concurrent: int = 10,
) -> Dict[str, WalletData]:
    """
    Asynchronously load activities for multiple wallets with concurrency limit.

    Args:
        wallet_identifiers: List of wallet addresses or usernames
        data_dir: Directory containing activity files
        pattern: Filename pattern
        max_concurrent: Maximum concurrent operations

    Returns:
        Dictionary mapping wallet identifiers to their data
    """
    semaphore = asyncio.Semaphore(max_concurrent)

    async def load_with_semaphore(wallet: str) -> Tuple[str, Optional[WalletData]]:
        async with semaphore:
            data = await load_wallet_activity_async(wallet, data_dir, pattern)
            return wallet, data

    logger.info(f"Loading activities for {len(wallet_identifiers)} wallets (max {max_concurrent} concurrent)")

    tasks = [load_with_semaphore(wallet) for wallet in wallet_identifiers]
    results = await asyncio.gather(*tasks)

    wallet_data: Dict[str, WalletData] = {}
    loaded_count = 0

    for wallet, data in results:
        if data is not None:
            wallet_data[wallet] = data
            loaded_count += 1

    logger.info(f"Successfully loaded {loaded_count}/{len(wallet_identifiers)} wallet activities")

    return wallet_data


class AsyncDataLoader:
    """Async data loader with caching support."""

    def __init__(
        self,
        data_dir: Union[str, Path],
        pattern: str = "wallet_activity_{wallet}.json",
        max_concurrent: int = 10,
    ) -> None:
        """
        Initialize the async data loader.

        Args:
            data_dir: Directory containing data files
            pattern: Filename pattern for wallet activity files
            max_concurrent: Maximum concurrent operations
        """
        self.data_dir = Path(data_dir)
        self.pattern = pattern
        self.max_concurrent = max_concurrent
        self._cache: Dict[str, WalletData] = {}

    async def load_wallet(
        self,
        wallet_identifier: str,
        use_cache: bool = True,
    ) -> Optional[WalletData]:
        """
        Load data for a single wallet.

        Args:
            wallet_identifier: Wallet address or username
            use_cache: Whether to use cached data

        Returns:
            WalletData if available
        """
        if use_cache and wallet_identifier in self._cache:
            return self._cache[wallet_identifier]

        data = await load_wallet_activity_async(
            wallet_identifier,
            self.data_dir,
            self.pattern,
        )

        if data is not None and use_cache:
            self._cache[wallet_identifier] = data

        return data

    async def load_wallets(
        self,
        wallet_identifiers: List[str],
        use_cache: bool = True,
    ) -> Dict[str, WalletData]:
        """
        Load data for multiple wallets.

        Args:
            wallet_identifiers: List of wallet identifiers
            use_cache: Whether to use cached data

        Returns:
            Dictionary of wallet data
        """
        # Check cache first
        to_load: List[str] = []
        results: Dict[str, WalletData] = {}

        for wallet in wallet_identifiers:
            if use_cache and wallet in self._cache:
                results[wallet] = self._cache[wallet]
            else:
                to_load.append(wallet)

        # Load remaining from files
        if to_load:
            loaded = await load_all_wallet_activities_async(
                to_load,
                self.data_dir,
                self.pattern,
                self.max_concurrent,
            )

            for wallet, data in loaded.items():
                results[wallet] = data
                if use_cache:
                    self._cache[wallet] = data

        return results

    def clear_cache(self) -> None:
        """Clear the data cache."""
        self._cache.clear()
        logger.debug("Cleared async loader cache")


def run_async(coro: Any) -> Any:
    """
    Helper to run async code from sync context.

    Args:
        coro: Coroutine to run

    Returns:
        Result of the coroutine
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Create new loop if current is running
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(asyncio.run, coro)
                return future.result()
        return loop.run_until_complete(coro)
    except RuntimeError:
        # No event loop, create one
        return asyncio.run(coro)
