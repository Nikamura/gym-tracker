#!/usr/bin/env python3
"""Consistent SQLite backup, then atomic publication to the mounted NAS."""
import datetime
import fcntl
import os
from pathlib import Path
import shutil
import sqlite3

KEEP = 14
root = Path('/opt/stacks/gym-tracker')

with (root / '.backup.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not os.path.ismount('/mnt/baium/data'):
        raise SystemExit('Baium data mount is unavailable; refusing local fallback')
    stage = root / 'backup.sqlite3'
    stage.unlink(missing_ok=True)
    source = sqlite3.connect(f'file:{root}/db/gym-tracker.sqlite?mode=ro', uri=True)
    dest = sqlite3.connect(stage)
    try:
        source.backup(dest)
        if dest.execute('pragma integrity_check').fetchone()[0] != 'ok':
            raise SystemExit('SQLite backup integrity check failed')
        if dest.execute('select count(*) from clubs').fetchone()[0] == 0:
            raise SystemExit('SQLite backup has no clubs')
    finally:
        dest.close()
        source.close()
    os.chmod(stage, 0o600)
    out = Path('/mnt/baium/data/backups/gym-tracker')
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = out / f'gym-tracker-{stamp}.sqlite3'
    temp = out / f'.{target.name}.tmp'
    shutil.copyfile(stage, temp)
    os.chmod(temp, 0o600)
    with temp.open('rb+') as copied:
        os.fsync(copied.fileno())
    os.replace(temp, target)
    directory = os.open(out, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    stage.unlink()
    for old in sorted(out.glob('gym-tracker-*.sqlite3'))[:-KEEP]:
        old.unlink()
    print(f'Gym Tracker backup verified: {target.name}')
