from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from core.rtdb_schema import sync_embedded_schema
from core.monitor_changes import ensure_monitor_changes
from scdfe_c.web.service import ScadaStore


def fields(connection, table):
    return [row[0] for row in connection.execute(
        'SELECT eng_name FROM rtdb_schema_columns WHERE table_name=? ORDER BY ordinal', (table,)
    )]


class EmbeddedSchemaTests(unittest.TestCase):
    def test_table_ddl_and_metadata_rollback_together(self):
        with closing(sqlite3.connect(':memory:')) as connection:
            connection.execute('BEGIN')
            connection.execute('CREATE TABLE device (idx INTEGER PRIMARY KEY, name TEXT)')
            sync_embedded_schema(connection)
            connection.commit()
            connection.execute('BEGIN')
            connection.execute('ALTER TABLE device ADD COLUMN p REAL DEFAULT 1.5')
            sync_embedded_schema(connection)
            self.assertEqual(fields(connection, 'device'), ['idx', 'name', 'p'])
            connection.rollback()
            self.assertEqual(fields(connection, 'device'), ['idx', 'name'])
            self.assertEqual([row[1] for row in connection.execute('PRAGMA table_info(device)')], ['idx', 'name'])
            connection.execute('BEGIN')
            connection.execute('DROP TABLE device')
            sync_embedded_schema(connection)
            connection.commit()
            self.assertEqual(fields(connection, 'device'), [])

    def test_scada_business_and_runtime_table_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'scdfe-c.live.sqlite3'
            store = ScadaStore(path)
            try:
                with store.connection() as connection:
                    self.assertEqual(tuple(connection.execute(
                        'SELECT eng_name,chn_name FROM rtdb_schema_database'
                    ).fetchone()), ('scdfe_c_live', 'scdfe-c.live'))
                    self.assertIn('pnt_no', fields(connection, 'fes_yc_define'))
                    ensure_monitor_changes(connection)
                    self.assertIn('change_id', fields(connection, '_scada_monitor_change'))
            finally:
                store.close()
            ScadaStore(path).close()
