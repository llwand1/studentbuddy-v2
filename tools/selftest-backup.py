import importlib.util
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing

spec = importlib.util.spec_from_file_location('backup', pathlib.Path(__file__).with_name('backup-db.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temp.name) / 'app'
        (self.base / 'data').mkdir(parents=True)
        self.backup = self.base / 'backup'
        self.backup.mkdir()
        self.remote = pathlib.Path(self.temp.name) / 'remote.git'
        self.run_git('init', '--bare', str(self.remote))
        self.run_git('-C', str(self.backup), 'init', '-b', 'master')
        self.run_git('-C', str(self.backup), 'config', 'user.name', 'test')
        self.run_git('-C', str(self.backup), 'config', 'user.email', 'test@example.invalid')
        self.run_git('-C', str(self.backup), 'remote', 'add', 'origin', str(self.remote))
        with closing(sqlite3.connect(self.base / 'data/studentbuddy.db')) as db:
            db.execute('CREATE TABLE retained(id INTEGER PRIMARY KEY)')
            db.execute('INSERT INTO retained VALUES (42)')
            db.commit()

    def tearDown(self):
        self.temp.cleanup()

    def run_git(self, *args):
        return subprocess.check_output(['git', *args], stderr=subprocess.PIPE, text=True).strip()

    def test_snapshot_is_restorable_and_remote_matches(self):
        snapshot = module.backup(self.base)
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute('SELECT id FROM retained').fetchone(), (42,))
        self.assertEqual(self.run_git('-C', str(self.backup), 'rev-parse', 'HEAD'),
                         self.run_git('--git-dir=' + str(self.remote), 'rev-parse', 'master'))

    def test_keys_and_code_packages_are_not_staged(self):
        (self.backup / '.mk').write_text('test-only-key')
        (self.backup / 'obsolete.tar.gz').write_bytes(b'test-only-code')
        module.backup(self.base)
        tracked = self.run_git('-C', str(self.backup), 'ls-files').splitlines()
        self.assertNotIn('.mk', tracked)
        self.assertNotIn('obsolete.tar.gz', tracked)

    def test_failed_push_still_keeps_fresh_snapshot_and_seven_daily_backups(self):
        for day in range(1, 10):
            with closing(sqlite3.connect(self.backup / f'sb-2026-01-{day:02}.db')) as db:
                db.execute('CREATE TABLE old(id INTEGER)')
        manual = self.backup / 'manual-recovery.db'
        manual.write_bytes(b'unchanged recovery marker')
        self.run_git('-C', str(self.backup), 'remote', 'set-url', 'origin', str(self.remote) + '-missing')
        with self.assertRaises(subprocess.CalledProcessError):
            module.backup(self.base)
        self.assertEqual(len(list(self.backup.glob('sb-*.db'))), 7)
        self.assertEqual(manual.read_bytes(), b'unchanged recovery marker')

    def test_old_snapshot_wal_cannot_override_new_live_snapshot(self):
        snapshot = module.backup(self.base)
        script = ('import sqlite3,os,sys; d=sqlite3.connect(sys.argv[1]); '
                  "d.execute('PRAGMA journal_mode=WAL'); d.execute('PRAGMA wal_autocheckpoint=0'); "
                  "d.execute('INSERT INTO retained VALUES(99)'); d.commit(); os._exit(0)")
        subprocess.run([sys.executable, '-c', script, str(snapshot)], check=True)
        self.assertTrue(pathlib.Path(str(snapshot) + '-wal').exists())
        with closing(sqlite3.connect(self.base / 'data/studentbuddy.db')) as live:
            live.execute('INSERT INTO retained VALUES (43)')
            live.commit()
        module.backup(self.base)
        with closing(sqlite3.connect(snapshot)) as restored:
            self.assertEqual(restored.execute('SELECT id FROM retained ORDER BY id').fetchall(), [(42,), (43,)])
            self.assertEqual(restored.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        self.assertFalse(pathlib.Path(str(snapshot) + '-wal').exists())


if __name__ == '__main__':
    unittest.main()
