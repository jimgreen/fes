"""Connection history journal, packet tracing and HTTP route tests (unittest)."""
import http.client
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from core.connection_history import ConnectionJournal, history_path, read_history, describe_packet
from core.connection_trace import ClientTrace


def wait_until(check, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(.03)
    raise AssertionError('condition timed out')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def meta(protocol='IEC104'):
    return dict(service='scdfe_s', protocol=protocol, channel_id=7, rtu_id=8)


class ConnectionHistoryTests(unittest.TestCase):
    def _make_history(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / 'scada.db'
        writer = ConnectionJournal(history_path(db, 's'))
        self.addCleanup(writer.close)
        return db, writer

    def test_retention_pagination_and_restart(self):
        import core.connection_history as module

        with patch.object(module, 'MAX_EVENTS', 5):
            db, writer = self._make_history()
            ident = writer.open(meta(), ('127.0.0.1', 1234), ('0.0.0.0', 2404))
            for n in range(12):
                writer.event(ident, 'log', str(n))
            writer.state(ident, 'closed', 'normal end')
            self.assertTrue(writer.flush())
            writer.close()
            item = read_history(db, 's', ident)['item']
            self.assertTrue(item['closed'])
            self.assertEqual(item['removed'], 9)
            rows = read_history(db, 's', ident, events=True, query={'limit': 2})
            older = read_history(db, 's', ident, events=True, query={'limit': 5, 'before': rows['next_before']})
            self.assertEqual(len(rows['items']), 2)
            self.assertEqual(len(older['items']), 3)
            self.assertFalse(set(r['id'] for r in rows['items']) & set(r['id'] for r in older['items']))
            self.assertEqual(read_history(db, 's', query={'rtu_id': 99})['total'], 0)

    def test_query_validation(self):
        db, _writer = self._make_history()
        for query in [{'limit': 'abc'}, {'limit': 201}, {'before': -1}, {'state': 'oops'}, {'kind': 'sql'}]:
            with self.subTest(query=query):
                with self.assertRaises(ValueError):
                    read_history(db, 's', query=query)

    def test_split_and_coalesced_modbus_packets_are_per_client(self):
        db, writer = self._make_history()
        a = ClientTrace(writer, meta('Modbus-TCP'), ('127.0.0.1', 1), ('127.0.0.1', 502))
        b = ClientTrace(writer, meta('Modbus-TCP'), ('127.0.0.1', 2), ('127.0.0.1', 502))
        first = bytes.fromhex('000100000006010300000002')
        second = bytes.fromhex('000100000006010600071234')
        a.packet('RX', first[:4])
        b.packet('RX', second)
        a.packet('RX', first[4:] + first)
        a.close('close')
        b.close('close')
        writer.flush()
        events = lambda obj: read_history(db, 's', obj.ident, events=True, query={'kind': 'packet'})['items']
        self.assertEqual([e['hex'] for e in events(a)], [first.hex(' ')] * 2)
        self.assertEqual([e['hex'] for e in events(b)], [second.hex(' ')])
        self.assertEqual(read_history(db, 's', a.ident)['item']['rx_bytes'], 24)

    def test_decode_gi_command_and_invalid(self):
        gi = bytes.fromhex('680e0000000064010600010000000014')
        gi_text = describe_packet('IEC104', 'RX', gi)
        self.assertTrue('总召' in gi_text or 'QOI' in gi_text)
        command = bytes.fromhex('680e000000002d010600010001600081')
        text = describe_packet('IEC104', 'RX', command)
        self.assertIn('选择', text)
        self.assertIn('24577', text)
        self.assertIn('解码失败', describe_packet('IEC104', 'RX', b'bad'))

    def test_packet_policy_keeps_counts_and_interactions_without_raw_bytes(self):
        db, writer = self._make_history()
        ident = writer.open({**meta(), 'packet_enabled': lambda: False}, 'peer', 'local')
        writer.event(ident, 'packet', 'IEC104', 'RX', bytes.fromhex('680407000000'))
        writer.flush()
        self.assertEqual(read_history(db, 's', ident)['item']['rx_bytes'], 6)
        self.assertEqual(read_history(db, 's', ident)['item']['packet_recording'], 0)
        self.assertEqual(read_history(db, 's', ident, events=True, query={'kind': 'packet'})['items'], [])
        self.assertIn('STARTDT', read_history(db, 's', ident, events=True, query={'kind': 'interaction'})['items'][0]['summary'])

    def test_stale_process_is_not_reported_as_normal_disconnection(self):
        db, writer = self._make_history()
        ident = writer.open(meta(), 'peer', 'local')
        writer.flush()
        writer.close()
        from contextlib import closing
        with closing(sqlite3.connect(history_path(db, 's'))) as con:
            con.execute('UPDATE connection_session SET heartbeat=? WHERE id=?', (time.time() - 30, ident))
            con.commit()
        item = read_history(db, 's', ident)['item']
        self.assertTrue(item['stale'])
        self.assertIsNone(item['closed'])

    def test_shared_writer_released_after_last_server(self):
        from core.connection_history import journal, release_journal

        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'db.db'
            first = journal(db, 's')
            second = journal(db, 's')
            self.assertIs(first, second)
            release_journal(first)
            self.assertTrue(second._thread.is_alive())
            release_journal(second)
            self.assertFalse(second._thread.is_alive())

    def test_opc_stream_disconnect_and_raw_observation(self):
        from core.connection_trace import observe_protocol

        class Protocol:
            def connection_made(self, transport): self.transport = transport
            def data_received(self, data): self.received = data
            def connection_lost(self, exc): self.error = exc

        class Transport:
            def get_extra_info(self, key): return ('127.0.0.1', 4840 if key == 'sockname' else 1234)
            def write(self, data): self.written = data

        db, writer = self._make_history()
        protocol = observe_protocol(Protocol(), writer, meta('OPC-UA'))
        protocol.connection_made(Transport())
        protocol.data_received(b'HELdata')
        protocol.transport.write(b'ACKdata')
        protocol.connection_lost(None)
        writer.flush()
        row = read_history(db, 's')['items'][0]
        self.assertTrue(row['closed'])
        self.assertEqual(row['rx_bytes'], 7)
        self.assertEqual(row['tx_bytes'], 7)
        self.assertEqual(len(read_history(db, 's', row['id'], events=True, query={'kind': 'packet'})['items']), 2)

    def test_http_pages_and_history(self):
        for component in ('s', 't'):
            with self.subTest(component=component):
                if component == 's':
                    from scdfe_s.web.server import make_server
                else:
                    from scdfe_t.web.server import make_server
                with tempfile.TemporaryDirectory() as tmp:
                    db = Path(tmp) / 'data.db'
                    server = make_server('127.0.0.1', 0, db_path=db)
                    store = server.store if component == 's' else server.trans_store.store
                    table = 'fes_rtu_define' if component == 's' else 'fes_scdfe_t_define'
                    definition = (
                        dict(rtu_id=8, channel_id=7, name='测试站 <甲>', channel_type='iec104')
                        if component == 's'
                        else dict(channel_id=7, name='测试转发 <甲>', protocol='iec104')
                    )
                    store.create_row(table, definition)
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    writer = ConnectionJournal(history_path(db, component))
                    ident = writer.open(meta(), ('127.0.0.1', 1234), ('127.0.0.1', 2404))
                    writer.event(ident, 'log', '<script>alert(1)</script>')
                    writer.flush()

                    def get(path):
                        con = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                        con.request('GET', path)
                        res = con.getresponse()
                        data = res.read()
                        con.close()
                        return res.status, data

                    try:
                        for path in ('/connections', '/connections/' + ident, '/static/connections.js', '/static/connections.css'):
                            status, _ = get(path)
                            self.assertEqual(status, 200, path)
                        status, body = get('/api/connections')
                        self.assertEqual(status, 200)
                        self.assertEqual(json.loads(body)['items'][0]['id'], ident)
                        self.assertEqual(json.loads(body)['items'][0]['display_name'], definition['name'])
                        status, body = get('/api/connections/options')
                        self.assertEqual(status, 200)
                        option = json.loads(body)['items'][0]
                        self.assertEqual(option['name'], definition['name'])
                        self.assertEqual(option['query'], {'rtu_id': 8} if component == 's' else {'channel_id': 7})
                        self.assertIn(definition['name'], option['label'])
                        status, body = get('/api/connections/' + ident)
                        self.assertEqual(status, 200)
                        self.assertEqual(json.loads(body)['item']['display_name'], definition['name'])
                        status, body = get('/api/connections/' + ident + '/events?kind=log')
                        self.assertEqual(status, 200)
                        self.assertEqual(len(json.loads(body)['items']), 2)
                        self.assertEqual(get('/api/connections/not-valid')[0], 400)
                        self.assertEqual(get('/api/connections/' + ('f' * 32))[0], 404)
                        self.assertEqual(get('/api/connections?unknown=1')[0], 400)
                        self.assertEqual(get('/api/connections/options?unknown=1')[0], 400)
                        key = [8] if component == 's' else [7]
                        store.update_row(table, key, {'name': '新名称'})
                        self.assertEqual(json.loads(get('/api/connections')[1])['items'][0]['display_name'], '新名称')
                    finally:
                        writer.close()
                        server.shutdown()
                        thread.join(3)
                        server.server_close()

    def test_name_options_keep_duplicate_names_and_historical_rtu_separate(self):
        from scdfe_c.web.service import ScadaStore
        from core.web_connections import connection_options, attach_connection_names

        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'data.db'
            store = ScadaStore(db)
            writer = ConnectionJournal(history_path(db, 's'))
            try:
                for rid, channel, protocol in ((8, 7, 'iec104'), (9, 7, 'modbus-tcp'), (10, 8, 'iec104')):
                    store.create_row('fes_rtu_define', dict(rtu_id=rid, channel_id=channel, channel_type=protocol, name='同名站'))
                historical = writer.open({**meta(), 'rtu_id': 99}, 'peer', 'local')
                writer.flush()
                items = connection_options(store, 's')['items']
                self.assertEqual(len(items), 4)
                self.assertEqual(len({x['label'] for x in items}), 4)
                self.assertEqual({x['query']['rtu_id'] for x in items}, {8, 9, 10, 99})
                self.assertIn('已删除', next(x['name'] for x in items if x['rtu_id'] == 99))
                result = read_history(db, 's', historical)
                attach_connection_names(result, store, 's', detail=True)
                self.assertEqual(result['item']['display_name'], '已删除的RTU（99）')
            finally:
                writer.close()
                store.close()

    def test_modbus_real_two_clients(self):
        from server.modbus_server import ModbusTcpServer

        db, writer = self._make_history()
        server = ModbusTcpServer(port=free_port())
        server.set_connection_history(writer, meta('Modbus-TCP'))
        clients = []
        try:
            server.start()
            for address in (1, 9):
                sock = socket.create_connection(('127.0.0.1', server.port), timeout=2)
                clients.append(sock)
                sock.sendall(bytes.fromhex('0001000000060103') + address.to_bytes(2, 'big') + b'\0\1')
                self.assertEqual(sock.recv(1024)[7], 3)
            wait_until(lambda: writer.flush() and read_history(db, 's')['total'] == 2)
            sessions = read_history(db, 's')['items']
            self.assertEqual(len({s['peer'] for s in sessions}), 2)
            for row in sessions:
                packets = read_history(db, 's', row['id'], events=True, query={'kind': 'packet'})['items']
                self.assertEqual(len(packets), 2)
                self.assertEqual({p['direction'] for p in packets}, {'RX', 'TX'})
        finally:
            for sock in clients:
                sock.close()
            server.close()
        wait_until(lambda: writer.flush() and all(s['closed'] for s in read_history(db, 's')['items']))

    def test_iec104_native_same_ip_reconnect_and_start_stop(self):
        from server.iec104_server import IEC104Server

        db, writer = self._make_history()
        server = IEC104Server(ip='127.0.0.1', port=free_port())
        server.set_connection_history(writer, meta())
        clients = []
        try:
            server.start()
            for _ in range(2):
                sock = socket.create_connection(('127.0.0.1', server.port), timeout=2)
                clients.append(sock)
                sock.sendall(bytes.fromhex('680407000000'))
                self.assertIn(bytes.fromhex('68040b000000'), sock.recv(1024))
            wait_until(lambda: writer.flush() and read_history(db, 's')['total'] == 2)
            first = read_history(db, 's')['items']
            self.assertEqual(len({s['peer'] for s in first}), 2)
            self.assertTrue(all(':' in s['peer'] for s in first))
            clients[0].sendall(bytes.fromhex('680413000000'))
            wait_until(lambda: writer.flush() and any(s['state'] == 'inactive' for s in read_history(db, 's')['items']))
            clients[0].close()
            wait_until(lambda: writer.flush() and any(s['closed'] for s in read_history(db, 's')['items']))
            clients.append(socket.create_connection(('127.0.0.1', server.port), timeout=2))
            wait_until(lambda: writer.flush() and read_history(db, 's')['total'] == 3)
            self.assertEqual(len({s['id'] for s in read_history(db, 's')['items']}), 3)
            for row in first:
                packets = read_history(db, 's', row['id'], events=True, query={'kind': 'packet'})['items']
                self.assertTrue(any('68 04 07 00 00 00' == p['hex'] for p in packets))
        finally:
            for sock in clients:
                sock.close()
            server.stop()
        self.assertTrue(writer.flush())
        self.assertTrue(all(s['closed'] for s in read_history(db, 's')['items']))


if __name__ == '__main__':
    unittest.main()
