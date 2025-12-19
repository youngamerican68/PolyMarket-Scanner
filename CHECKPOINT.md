# Checkpoint & Rollback

## Create Checkpoint

    ./scripts/checkpoint.sh

Creates a git tag and saves env/config to `.checkpoints/<TAG>/`.

## Rollback

    ./scripts/rollback.sh <TAG>
    ./scripts/rollback.sh <TAG> --reset-db  # also wipes docker volumes

## Healthcheck

    ./scripts/healthcheck.sh

Prints DB freshness metrics. Runs automatically after rollback.

## List Checkpoints

    git tag -l 'checkpoint-*'
    ls .checkpoints/
