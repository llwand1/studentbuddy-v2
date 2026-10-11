#!/usr/bin/env python3
"""Snapshot, retain seven daily databases, and report backup synchronization failures."""
import datetime
from contextlib import closing
import os
import pathlib
import sqlite3
import subprocess
import sys


def git(directory, *args):
    return subprocess.run(['git', '-C', str(directory), *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def backup(base):
    base = pathlib.Path(base).resolve()
    directory = base / 'backup'
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.resolve().parent != base:
        raise RuntimeError('Unexpected backup directory')
    if not (directory / '.git').is_dir():
        raise RuntimeError('Initialize the backup repository before enabling synchronization')
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()
    target = directory / ('sb-' + today.isoformat() + '.db')
    temporary = directory / (target.name + '.partial')
    if target.is_symlink() or temporary.is_symlink():
        raise RuntimeError('Unexpected snapshot link')
    with closing(sqlite3.connect('file:' + str(base / 'data/studentbuddy.db') + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(temporary)) as dest:
            source.backup(dest)
            # Published snapshots are single files; WAL must not survive atomic replacement.
            dest.execute('PRAGMA journal_mode = DELETE')
            if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Database backup integrity check failed')
    os.chmod(temporary, 0o600)
    if target.exists():
        # Let SQLite retire old WAL under its own locking. A busy reader fails this run.
        with closing(sqlite3.connect(target)) as previous:
            previous.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            previous.execute('PRAGMA journal_mode = DELETE')
    temporary.replace(target)
    snapshots = []
    for item in directory.glob('sb-????-??-??.db'):
        if item.is_symlink() or not item.is_file() or item.resolve().parent != directory.resolve():
            continue
        try:
            date = datetime.date.fromisoformat(item.name[3:-3])
        except ValueError:
            continue
        snapshots.append((date, item))
    # Local retention is independent of whether the remote push succeeds.
    for _, item in sorted(snapshots, reverse=True)[7:]:
        item.unlink()
    ignore = directory / '.gitignore'
    text = ignore.read_text() if ignore.exists() else ''
    for rule in ['*.tar.gz', '.mk', '*.mk', '.env', '*.partial', '*-wal', '*-shm']:
        if rule not in text.splitlines():
            text += ('\n' if text and not text.endswith('\n') else '') + rule + '\n'
    ignore.write_text(text)
    git(directory, 'add', '-A')
    changed = subprocess.run(['git', '-C', str(directory), 'diff', '--cached', '--quiet']).returncode
    if changed == 1:
        git(directory, 'commit', '-m', 'Database backup ' + today.isoformat())
    elif changed != 0:
        raise RuntimeError('Could not inspect staged backup')
    branch = git(directory, 'branch', '--show-current').stdout.strip()
    if branch not in {'main', 'master'}:
        raise RuntimeError('Unexpected backup branch')
    git(directory, 'push', 'origin', branch)
    return target


if __name__ == '__main__':
    try:
        result = backup(os.environ.get('SB_BACKUP_BASE', '/opt/studentbuddy'))
        print('Database snapshot integrity and remote synchronization verified: ' + result.name)
    except subprocess.CalledProcessError as error:
        print('Backup synchronization failed: ' + (error.stderr or str(error)).strip(), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Backup failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
