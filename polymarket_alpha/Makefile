# Polymarket Alpha Wallet Tracker - Makefile
# Common development and operational tasks

.PHONY: help install install-dev test lint type-check format run run-debug clean

# Default target
help:
	@echo "Polymarket Alpha Wallet Tracker"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Development:"
	@echo "  install       Install production dependencies"
	@echo "  install-dev   Install all dependencies including dev tools"
	@echo "  test          Run test suite"
	@echo "  test-cov      Run tests with coverage report"
	@echo "  lint          Run linter (ruff)"
	@echo "  type-check    Run type checker (mypy)"
	@echo "  format        Format code (ruff)"
	@echo ""
	@echo "Running:"
	@echo "  run           Run the pipeline (production mode)"
	@echo "  run-debug     Run the pipeline in debug mode"
	@echo "  run-cli       Run with enhanced CLI interface"
	@echo ""
	@echo "Maintenance:"
	@echo "  clean         Remove build artifacts and caches"
	@echo "  setup-dirs    Create required directories"

# Installation
install:
	pip install -r requirements.txt

install-dev:
	pip install -r requirements.txt
	pip install pytest pytest-asyncio pytest-cov mypy ruff

# Testing
test:
	cd tests && python -m pytest -v

test-cov:
	cd tests && python -m pytest --cov=.. --cov-report=html --cov-report=term-missing

# Code quality
lint:
	ruff check .

type-check:
	mypy . --ignore-missing-imports

format:
	ruff check --fix .
	ruff format .

# Running the pipeline
run:
	python main_runner.py --config config.json

run-debug:
	python main_runner.py --debug

run-cli:
	python cli.py

run-cli-debug:
	python cli.py --debug --verbose

# Maintenance
clean:
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
	find . -type f -name "*.pyo" -delete 2>/dev/null || true
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".mypy_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name "htmlcov" -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name ".coverage" -delete 2>/dev/null || true
	rm -f config_debug.json config_cli_temp.json 2>/dev/null || true

setup-dirs:
	mkdir -p data output credentials
	touch data/.gitkeep output/.gitkeep credentials/.gitkeep

# Quick checks before commit
pre-commit: lint type-check test
	@echo "All checks passed!"
