#!/usr/bin/env python3
"""Restore a SQLite snapshot into a new database only; never overwrite live data."""
import argparse
from contextlib import closing
import os
import pathlib
import sqlite3
import sys
import tempfile


def checked_path(value):
    candidate = pathlib.Path(os.path.abspath(value))
    if candidate.is_symlink() or candidate.resolve() != candidate:
        raise ValueError('Symbolic links or redirected paths are not accepted')
    return candidate


def restore(source, destination):
    source, destination = checked_path(source), checked_path(destination)
    if not source.is_file():
        raise ValueError('Snapshot must be a regular existing file')
    with source.open('rb') as header:
        if header.read(16) != b'SQLite format 3\x00':
            raise sqlite3.DatabaseError('Snapshot does not have a SQLite database header')
    if destination.exists() or destination.is_symlink():
        raise FileExistsError('Destination already exists; restore to a new isolated database')
    if not destination.parent.is_dir():
        raise ValueError('Create the recovery directory first')
    descriptor, temporary_name = tempfile.mkstemp(prefix='.sb-restore-', suffix='.tmp', dir=destination.parent)
    os.close(descriptor)
    temporary = pathlib.Path(temporary_name)
    try:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original:
            with closing(sqlite3.connect(temporary)) as recovered:
                original.backup(recovered)
                recovered.execute('PRAGMA journal_mode = DELETE')
                if recovered.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Recovered snapshot failed integrity verification')
        os.chmod(temporary, 0o600)
        # Atomic, no-clobber publication on the same filesystem, including destination races.
        os.link(temporary, destination)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot')
    parser.add_argument('new_database')
    args = parser.parse_args()
    try:
        print('Recovery integrity verified: ' + str(restore(args.snapshot, args.new_database)))
    except (OSError, ValueError, sqlite3.Error) as error:
        print('Recovery refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
