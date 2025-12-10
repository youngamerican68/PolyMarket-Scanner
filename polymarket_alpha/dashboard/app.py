#!/usr/bin/env python3
"""
Polymarket Alpha Dashboard

Local web dashboard for tracking Polymarket traders and detecting insider patterns.
Mirrors Polymarket's UI with added insider detection layer.

Usage:
    python -m dashboard.app
    # or
    uvicorn dashboard.app:app --reload --port 8000
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import markdown
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from dashboard.services.trader_service import TraderService
from dashboard.api import traders as traders_api
from dashboard.api import discovery as discovery_api
from dashboard.api.discovery import get_discovery_status, get_discovered_insiders

# Initialize FastAPI app
app = FastAPI(
    title="Polymarket Alpha",
    description="Insider detection dashboard for Polymarket traders",
    version="1.0.0",
)

# Mount static files
static_path = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_path)), name="static")

# Setup templates
templates_path = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(templates_path))

# Include API routes
app.include_router(traders_api.router, prefix="/api")
app.include_router(discovery_api.router, prefix="/api")

# Initialize services
trader_service = TraderService()

# Reports directory
REPORTS_DIR = Path(__file__).parent.parent / "output" / "daily_reports"


# Template filters
def format_money(value: float) -> str:
    """Format number as money string."""
    if value >= 1_000_000:
        return f"${value / 1_000_000:.2f}M"
    elif value >= 1_000:
        return f"${value / 1_000:.1f}K"
    else:
        return f"${value:,.0f}"


def format_percent(value: float) -> str:
    """Format number as percentage."""
    if value > 0:
        return f"+{value:.1f}%"
    return f"{value:.1f}%"


def format_time_ago(timestamp: str) -> str:
    """Format timestamp as relative time."""
    return timestamp  # Already in relative format from scraper


templates.env.filters["money"] = format_money
templates.env.filters["percent"] = format_percent
templates.env.filters["time_ago"] = format_time_ago


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    """Dashboard home - list of watched traders."""
    traders = trader_service.get_watched_traders()
    alerts = trader_service.get_recent_alerts()

    return templates.TemplateResponse("index.html", {
        "request": request,
        "traders": traders,
        "alerts": alerts,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    })


@app.get("/trader/{trader_id}", response_class=HTMLResponse)
async def trader_detail(request: Request, trader_id: str):
    """Single trader detail view."""
    trader = trader_service.get_trader(trader_id)

    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    return templates.TemplateResponse("trader.html", {
        "request": request,
        "trader": trader,
    })


@app.get("/alerts", response_class=HTMLResponse)
async def alerts_page(request: Request):
    """Alerts list page."""
    alerts = trader_service.get_all_alerts()

    return templates.TemplateResponse("alerts.html", {
        "request": request,
        "alerts": alerts,
    })


@app.post("/scrape/{trader_id}")
async def trigger_scrape(trader_id: str):
    """Trigger a scrape for a specific trader."""
    # This would integrate with Firecrawl
    # For now, return a placeholder response
    return {
        "status": "queued",
        "trader_id": trader_id,
        "message": f"Scrape queued for {trader_id}",
    }


@app.get("/discover", response_class=HTMLResponse)
async def discover_page(request: Request):
    """Discovery page - find new potential insiders."""
    status = get_discovery_status()
    insiders = get_discovered_insiders()
    alerts = trader_service.get_recent_alerts()

    return templates.TemplateResponse("discover.html", {
        "request": request,
        "status": status,
        "insiders": insiders,
        "alerts": alerts,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    })


@app.get("/reports", response_class=HTMLResponse)
async def reports_list(request: Request):
    """List all daily reports."""
    reports = []

    if REPORTS_DIR.exists():
        for file in sorted(REPORTS_DIR.glob("*.md"), reverse=True):
            # Extract date from filename like "top10_positions_2025-12-07.md"
            date_match = re.search(r'(\d{4}-\d{2}-\d{2})', file.name)
            date_str = date_match.group(1) if date_match else file.stem

            # Get file size
            size = file.stat().st_size
            if size >= 1024:
                size_str = f"{size / 1024:.1f} KB"
            else:
                size_str = f"{size} bytes"

            reports.append({
                "filename": file.name,
                "date": date_str,
                "size": size_str,
            })

    alerts = trader_service.get_recent_alerts()

    return templates.TemplateResponse("reports.html", {
        "request": request,
        "reports": reports,
        "alerts": alerts,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    })


@app.get("/reports/{filename}", response_class=HTMLResponse)
async def report_detail(request: Request, filename: str):
    """View a specific report."""
    file_path = REPORTS_DIR / filename

    if not file_path.exists() or not file_path.suffix == ".md":
        raise HTTPException(status_code=404, detail="Report not found")

    # Read and convert markdown to HTML
    md_content = file_path.read_text()
    html_content = markdown.markdown(md_content, extensions=['tables', 'fenced_code'])

    # Extract date from filename
    date_match = re.search(r'(\d{4}-\d{2}-\d{2})', filename)
    report_date = date_match.group(1) if date_match else filename

    alerts = trader_service.get_recent_alerts()

    return templates.TemplateResponse("report_detail.html", {
        "request": request,
        "content": html_content,
        "filename": filename,
        "report_date": report_date,
        "alerts": alerts,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    })


@app.get("/reports/{filename}/raw", response_class=PlainTextResponse)
async def report_raw(filename: str):
    """View raw markdown of a report."""
    file_path = REPORTS_DIR / filename

    if not file_path.exists() or not file_path.suffix == ".md":
        raise HTTPException(status_code=404, detail="Report not found")

    return file_path.read_text()


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
