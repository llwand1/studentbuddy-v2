import importlib.util
import pathlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('restore', pathlib.Path(__file__).with_name('restore-db.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name).resolve()
        self.source, self.target = self.root / 'snapshot.db', self.root / 'recovery.db'
        with closing(sqlite3.connect(self.source)) as db:
            db.execute('CREATE TABLE retained(id INTEGER PRIMARY KEY)')
            db.execute('INSERT INTO retained VALUES (42)')
            db.commit()

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_snapshot_preserves_source_and_restores_integrity(self):
        original = self.source.read_bytes()
        module.restore(self.source, self.target)
        self.assertEqual(self.source.read_bytes(), original)
        with closing(sqlite3.connect(self.target)) as db:
            self.assertEqual(db.execute('SELECT id FROM retained').fetchone(), (42,))
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone(), ('delete',))
        self.assertFalse(list(self.root.glob('.sb-restore-*')))

    def test_committed_wal_data_is_not_lost(self):
        with closing(sqlite3.connect(self.source)) as live:
            live.execute('PRAGMA journal_mode=WAL')
            live.execute('PRAGMA wal_autocheckpoint=0')
            live.execute('INSERT INTO retained VALUES (99)')
            live.commit()
            module.restore(self.source, self.target)
            with closing(sqlite3.connect(self.target)) as restored:
                self.assertEqual(restored.execute('SELECT id FROM retained ORDER BY id').fetchall(), [(42,), (99,)])
            self.assertFalse(pathlib.Path(str(self.target) + '-wal').exists())

    def test_corrupt_snapshot_is_not_published(self):
        self.source.write_bytes(b'not a database')
        with self.assertRaises(sqlite3.DatabaseError):
            module.restore(self.source, self.target)
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob('.sb-restore-*')))

    def test_existing_target_is_never_overwritten(self):
        self.target.write_bytes(b'keep this original')
        with self.assertRaises(FileExistsError):
            module.restore(self.source, self.target)
        self.assertEqual(self.target.read_bytes(), b'keep this original')

    def test_empty_file_is_not_misreported_as_a_valid_backup(self):
        self.source.write_bytes(b'')
        with self.assertRaises(sqlite3.DatabaseError):
            module.restore(self.source, self.target)
        self.assertFalse(self.target.exists())

    def test_unicode_and_uri_special_characters_in_paths_are_handled(self):
        renamed = self.root / '学习 snapshot %#.db'
        self.source.rename(renamed)
        module.restore(renamed, self.target)
        with closing(sqlite3.connect(self.target)) as restored:
            self.assertEqual(restored.execute('SELECT id FROM retained').fetchone(), (42,))

    def test_destination_race_does_not_clobber_other_data(self):
        real_link = module.os.link

        def competing_link(source, target):
            self.target.write_bytes(b'concurrent data')
            return real_link(source, target)

        with patch.object(module.os, 'link', competing_link), self.assertRaises(FileExistsError):
            module.restore(self.source, self.target)
        self.assertEqual(self.target.read_bytes(), b'concurrent data')
        self.assertFalse(list(self.root.glob('.sb-restore-*')))

    def test_symlink_source_and_destination_are_refused(self):
        linked = self.root / 'linked.db'
        try:
            linked.symlink_to(self.source)
        except OSError:
            self.skipTest('Symlink creation not available for this user')
        with self.assertRaises(ValueError):
            module.restore(linked, self.target)
        self.target.symlink_to(self.source)
        with self.assertRaises(ValueError):
            module.restore(self.source, self.target)


if __name__ == '__main__':
    unittest.main()
