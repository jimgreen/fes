"""Independent wire fixtures for the standard-library IEC104 engine (unittest)."""
from datetime import datetime, timezone
import socket
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from core import iec104_python as protocol
from tools.verify_iec104_wire_contracts import RawPeer


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class IEC104PythonWireTests(unittest.TestCase):
    def test_hostname_retries_other_resolved_addresses(self):
        server = protocol.Server(ip='127.0.0.1', port=port())
        server.add_station(1).add_point(1, protocol.Type.M_SP_NA_1)
        real_resolve = socket.getaddrinfo

        def resolve(host, target_port, *args, **kwargs):
            if host == 'iec104.test':
                return [
                    (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.2', target_port)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', target_port)),
                ]
            return real_resolve(host, target_port, *args, **kwargs)

        with patch.object(socket, 'getaddrinfo', resolve):
            client = protocol.Client()
            connection = client.add_connection('iec104.test', server.port, init=protocol.Init.NONE)
            connection.add_station(1).add_point(1, protocol.Type.M_SP_NA_1)
            try:
                server.start()
                client.start()
                deadline = time.monotonic() + 4
                while connection.state != protocol.ConnectionState.OPEN:
                    self.assertLess(time.monotonic(), deadline, connection.last_error)
                    time.sleep(.01)
                self.assertTrue(connection.interrogation(1))
            finally:
                client.stop()
                server.stop()

    def test_codec_cp24_and_cp56_are_explicit_utc_calendar(self):
        stamp = datetime(2026, 11, 15, 12, 34, 56, 789000, timezone.utc)
        for typ, suffix in (
            (2, bytes.fromhex('d5dd22')),
            (30, bytes.fromhex('d5dd220cef0b1a')),
        ):
            data = protocol.encode_information(typ, protocol.SingleInfo(True, recorded_at=stamp))
            self.assertEqual(data, b'\x01' + suffix)
            info = protocol.decode_information(typ, data, reference=stamp)
            self.assertIs(info.value, True)
            self.assertEqual(info.recorded_at, stamp)

    def test_window_ack_and_sequence_error_close_only_offending_connection(self):
        server = protocol.Server(ip='127.0.0.1', port=port())
        server.protocol_parameters.send_window_size = 2
        point = server.add_station(1).add_point(1, protocol.Type.M_SP_NA_1)
        server.start()
        try:
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as sock:
                raw = RawPeer(sock)
                raw.u(7)
                self.assertEqual(raw.receive()[2], 11)
                for value in (True, False, True):
                    point.value = value
                    self.assertTrue(point.transmit(protocol.Cot.SPONTANEOUS))
                sock.settimeout(2)
                data = b''
                while len(data) < 32:
                    data += sock.recv(32 - len(data))
                self.assertEqual(len(data), 32)
                self.assertEqual([data[2], data[18]], [0, 2])
                sock.settimeout(.15)
                with self.assertRaises(socket.timeout):
                    sock.recv(1)
                sock.sendall(bytes.fromhex('680401000400'))
                raw.rx = 2
                self.assertEqual(raw.receive()[2], 4)
                sock.sendall(bytes.fromhex('680e0e00060064010600010000000014'))
                sock.settimeout(2)
                self.assertEqual(sock.recv(1), b'')
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as sock:
                raw = RawPeer(sock)
                raw.u(7)
                self.assertEqual(raw.receive()[2], 11)
        finally:
            server.stop()

    def test_configured_asdu_limit_is_enforced_for_batching(self):
        server = protocol.Server(ip='127.0.0.1', port=port())
        server.protocol_parameters.max_asdu_length = 24
        station = server.add_station(1)
        points = [station.add_point(i, protocol.Type.M_ME_NC_1) for i in range(1, 13)]
        for p in points:
            p.value = float(p.io_address)
        server.start()
        try:
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as sock:
                raw = RawPeer(sock)
                raw.u(7)
                raw.until(lambda f: f[2] == 11)
                self.assertTrue(server.transmit_batch(protocol.Batch(protocol.Cot.SPONTANEOUS, points)))
                count = 0
                while count < len(points):
                    frame = raw.receive()
                    if frame[2] & 1:
                        continue
                    self.assertLessEqual(len(frame) - 6, 24)
                    count += frame[7] & 127
                self.assertEqual(count, len(points))
        finally:
            server.stop()

    def test_standard_library_only_without_site_packages(self):
        code = """
import socket, sys
from core.iec104_python import Server, Client, Type, Init, Cot
import time
with socket.socket() as s:
    s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
server=Server(ip='127.0.0.1',port=port)
p=server.add_station(1).add_point(1,Type.M_SP_NA_1);p.value=True
client=Client(command_timeout_ms=1000)
c=client.add_connection('127.0.0.1',port,Init.NONE)
q=c.add_station(1).add_point(1,Type.M_SP_NA_1)
try:
    server.start();client.start()
    end=time.monotonic()+3
    while c.state.name!='OPEN' and time.monotonic()<end: time.sleep(.01)
    assert c.interrogation(1)
    assert q.value is True
    assert not any(k=='c104' or k.startswith('c104.') for k in sys.modules)
finally:
    client.stop();server.stop()
"""
        subprocess.run([sys.executable, '-S', '-c', code], check=True, timeout=10)

    def test_t1_timeout_and_t3_testfr(self):
        server = protocol.Server(ip='127.0.0.1', port=port())
        server.protocol_parameters.keep_alive_interval = .12
        server.protocol_parameters.message_timeout = .25
        server.start()
        try:
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as sock:
                raw = RawPeer(sock)
                raw.u(7)
                raw.until(lambda f: f[2] == 11)
                self.assertEqual(raw.until(lambda f: f[2] == 67, timeout=1), bytes.fromhex('680443000000'))
                sock.settimeout(1)
                self.assertEqual(sock.recv(6), b'')
        finally:
            server.stop()

    def test_malformed_frame_closes_connection(self):
        frames = [
            '68050100000000',
            '68050700000000',
            '680401000200',
            '68080e00000001020304',
        ]
        for frame in frames:
            with self.subTest(frame=frame):
                server = protocol.Server(ip='127.0.0.1', port=port())
                server.start()
                try:
                    with socket.create_connection(('127.0.0.1', server.port), timeout=2) as sock:
                        raw = RawPeer(sock)
                        raw.u(7)
                        raw.until(lambda f: f[2] == 11)
                        sock.sendall(bytes.fromhex(frame))
                        sock.settimeout(2)
                        self.assertEqual(sock.recv(1), b'')
                finally:
                    server.stop()

    def test_invalid_control_flags_never_invoke_application(self):
        cases = [
            (45, 6 | 128, b'\x01'),
            (45, 6 | 64, b'\x01'),
            (45, 6, b'\x03'),
            (58, 6, bytes.fromhex('010000800101011a')),
            (58, 6, bytes.fromhex('010000000100001a')),
        ]
        for typ, cot, payload in cases:
            with self.subTest(typ=typ, cot=cot):
                server = protocol.Server(ip='127.0.0.1', port=port())
                point = server.add_station(1).add_point(1, protocol.Type(typ))
                commands = []
                point.on_receive(lambda *args: commands.append(args) or protocol.ResponseState.SUCCESS)
                server.start()
                try:
                    with socket.create_connection(('127.0.0.1', server.port), timeout=2) as sock:
                        raw = RawPeer(sock)
                        raw.u(7)
                        raw.until(lambda f: f[2] == 11)
                        raw.asdu(bytes((typ, 1, cot, 0, 1, 0, 1, 0, 0)) + payload)
                        reply = raw.until(lambda f: len(f) > 12 and f[6] == typ)
                        self.assertEqual(reply[8] & 127, 7 | 64)
                        self.assertEqual(commands, [])
                finally:
                    server.stop()

    def test_sequence_wrap_t2_ack_and_explicit_testfr(self):
        from client.iec104 import IEC104Master
        from server.iec104_server import IEC104Server

        server = IEC104Server(ip='127.0.0.1', port=port(), t2=.05)
        server.add_point('yx', 1, value=True)
        client = IEC104Master('127.0.0.1', server.port, init='NONE', t2=.05)
        client.add_point('yx', 1)
        try:
            server.start()
            client.connect(2)
            outbound = server.server._reactor.links[0]
            inbound = client.connection._link
            outbound.send_sequence = outbound.ack_sequence = 32767
            inbound.receive_sequence = 32767
            for value in (False, True):
                server.update('yx', 1, value)
            deadline = time.monotonic() + 2
            while outbound.outstanding or client.value('yx', 1).value is not True:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.01)
            self.assertEqual(outbound.send_sequence, 1)
            self.assertEqual(outbound.ack_sequence, 1)
            self.assertTrue(client.test_fr())
        finally:
            client.close()
            server.stop()

    def test_cp24_adapter_roundtrip(self):
        from client.iec104 import IEC104Master
        from server.iec104_server import IEC104Server

        cases = [
            ('yx', 1, True, 2),
            ('yx', 3, True, 4),
            ('yx', 5, -4, 6),
            ('yc', 9, .25, 10),
            ('yc', 11, -123, 12),
            ('yc', 13, 12.5, 14),
        ]
        for kind, base, value, typ in cases:
            with self.subTest(kind=kind, base=base):
                server = IEC104Server(ip='127.0.0.1', port=port())
                server.add_point(kind, 1, data_type=base, time_tag='CP24Time2a', value=value)
                client = IEC104Master('127.0.0.1', server.port, init='NONE')
                p = client.add_point(kind, 1, data_type=base, time_tag='CP24Time2a')
                try:
                    server.start()
                    client.connect(2)
                    client.general_interrogation()
                    sample = client.value(kind, 1)
                    self.assertEqual(int(p.type), typ)
                    self.assertEqual(sample.value, value)
                    self.assertLess(abs((sample.recorded_at - datetime.now(timezone.utc)).total_seconds()), 2)
                finally:
                    client.close()
                    server.stop()


if __name__ == '__main__':
    unittest.main()
