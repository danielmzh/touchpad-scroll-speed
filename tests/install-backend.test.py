#!/usr/bin/env python3
"""Verify user-service installation without touching the desktop session."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('installer', PROJECT / 'install-backend.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='touchpad-install-test-')
        self.base = Path(self.directory.name)
        self.library = self.base / 'local/lib/libtouchpad-scroll.so'
        self.dropin = self.base / 'config/service.d/80-touchpad-scroll.conf'
        self.project = self.base / 'project'
        (self.project / 'dist').mkdir(parents=True)
        (self.project / 'dist/libtouchpad-scroll.so').write_bytes(b'library-version-1')
        self.properties = [
            patch.object(installer, 'PROJECT', self.project),
            patch.object(installer, 'LIBRARY', self.library),
            patch.object(installer, 'DROPIN', self.dropin),
        ]
        for item in self.properties:
            item.start()

    def tearDown(self):
        for item in reversed(self.properties):
            item.stop()
        self.directory.cleanup()

    def query(self, *args):
        self.assertIn('--property=LoadState', args)
        return 'loaded'

    def bus_value(self, signature, *args):
        if signature == 'o':
            return '/org/freedesktop/systemd1/unit/test'
        self.assertEqual(signature, 'as')
        if args[2] == installer.MANAGER_INTERFACE:
            return ['LD_PRELOAD=/tmp/manager.so', 'IGNORED=value']
        return ['LANG=es_CL.UTF-8',
                'LD_PRELOAD=/tmp/other%library.so:' + str(self.library)]

    def test_install_update_and_uninstall(self):
        with patch.object(installer, 'query', side_effect=self.query), \
             patch.object(installer, 'bus_value', side_effect=self.bus_value), \
             patch.object(installer.subprocess, 'run') as reload:
            installer.install()
            config = self.dropin.read_text()
            self.assertEqual(config.count(str(self.library)), 1)
            self.assertIn('/tmp/other%%library.so', config)
            self.assertNotIn('manager.so', config)
            self.assertNotIn('IGNORED', config)
            self.assertEqual(self.library.read_bytes(), b'library-version-1')
            self.assertEqual(self.library.stat().st_mode & 0o777, 0o755)
            # Update replaces the inode, preserving an already mapped old file.
            with self.library.open('rb') as old_library:
                (self.project / 'dist/libtouchpad-scroll.so').write_bytes(b'version-2')
                installer.install()
                self.assertEqual(old_library.read(), b'library-version-1')
                self.assertEqual(self.library.read_bytes(), b'version-2')
            installer.uninstall()
            self.assertFalse(self.dropin.exists())
            self.assertTrue(self.library.exists())
            self.assertEqual(reload.call_count, 3)
            reload.assert_called_with(['systemctl', '--user', 'daemon-reload'], check=True)

    def test_missing_service_writes_nothing(self):
        with patch.object(installer, 'query', return_value='not-found'):
            with self.assertRaises(RuntimeError):
                installer.install()
        self.assertFalse(self.dropin.exists())
        self.assertFalse(self.library.exists())

    def test_inherit_manager_preloads_when_service_has_none(self):
        def bus_value(signature, *args):
            if signature == 'o':
                return '/org/freedesktop/systemd1/unit/test'
            if args[2] == installer.MANAGER_INTERFACE:
                return ['LD_PRELOAD=/tmp/manager.so']
            return ['LANG=es_CL.UTF-8']
        with patch.object(installer, 'query', side_effect=self.query), \
             patch.object(installer, 'bus_value', side_effect=bus_value), \
             patch.object(installer.subprocess, 'run'):
            installer.install()
        self.assertIn('/tmp/manager.so', self.dropin.read_text())

    def test_manager_preloads_preserve_spaces_and_literal_dollar(self):
        def bus_value(signature, *args):
            if signature == 'o':
                return '/org/freedesktop/systemd1/unit/test'
            if args[2] == installer.MANAGER_INTERFACE:
                return ['LD_PRELOAD=/tmp/first.so /tmp/literal$library.so']
            return []
        with patch.object(installer, 'query', side_effect=self.query), \
             patch.object(installer, 'bus_value', side_effect=bus_value), \
             patch.object(installer.subprocess, 'run'):
            installer.install()
        self.assertIn(':/tmp/first.so:/tmp/literal$library.so"', self.dropin.read_text())
        self.assertNotIn("$'", self.dropin.read_text())

    def test_bus_value_uses_typed_json(self):
        for signature, values, expected in [
                ('as', ['LD_PRELOAD=/tmp/a.so /tmp/$b.so'],
                 ['LD_PRELOAD=/tmp/a.so /tmp/$b.so']),
                ('o', ['/org/freedesktop/systemd1/unit/test'],
                 '/org/freedesktop/systemd1/unit/test')]:
            with self.subTest(signature=signature), \
                 patch.object(installer.subprocess, 'check_output',
                              return_value=json.dumps({'type': signature, 'data': values})) as call:
                actual = installer.bus_value(signature, 'get-property', '/path', 'interface', 'value')
                self.assertEqual(actual, expected)
                self.assertEqual(call.call_args.args[0][:5],
                                 ['busctl', '--user', '--json=short', 'get-property', installer.BUS_NAME])

    def test_invalid_bus_reply_writes_nothing(self):
        with patch.object(installer, 'query', side_effect=self.query), \
             patch.object(installer.subprocess, 'check_output',
                          return_value='{"type":"o","data":[]}'):
            with self.assertRaises(RuntimeError):
                installer.install()
        self.assertFalse(self.dropin.exists())
        self.assertFalse(self.library.exists())


if __name__ == '__main__':
    unittest.main()
