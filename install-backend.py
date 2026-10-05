#!/usr/bin/env python3
"""Install the scroll library for the user GNOME Wayland service only."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PROJECT = Path(__file__).resolve().parent
LIBRARY = Path.home() / '.local/lib/touchpad-scroll/libtouchpad-scroll.so'
CONFIG = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
DROPIN = CONFIG / 'systemd/user/org.gnome.Shell@wayland.service.d/80-touchpad-scroll.conf'
SERVICE = 'org.gnome.Shell@wayland.service'
BUS_NAME = 'org.freedesktop.systemd1'
MANAGER_PATH = '/org/freedesktop/systemd1'
MANAGER_INTERFACE = 'org.freedesktop.systemd1.Manager'
SERVICE_INTERFACE = 'org.freedesktop.systemd1.Service'


def query(*args):
    return subprocess.check_output(['systemctl', '--user', *args], text=True).strip()


def bus_value(signature, *args):
    """Read typed D-Bus values without systemctl's shell-oriented escaping."""
    output = subprocess.check_output(
        ['busctl', '--user', '--json=short', args[0], BUS_NAME, *args[1:]], text=True)
    try:
        result = json.loads(output)
    except (ValueError, TypeError) as error:
        raise RuntimeError('Invalid JSON response from systemd.') from error
    if (not isinstance(result, dict) or result.get('type') != signature or
            not isinstance(result.get('data'), list)):
        raise RuntimeError('Unexpected D-Bus response from systemd.')
    values = result['data']
    if signature == 'o':
        if len(values) != 1 or not isinstance(values[0], str) or not values[0].startswith('/'):
            raise RuntimeError('Invalid D-Bus path for the GNOME service.')
        return values[0]
    if signature == 'as' and all(isinstance(value, str) for value in values):
        return values
    raise RuntimeError('Unsupported D-Bus type for scroll configuration.')


def atomic_write(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            os.fchmod(output.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install():
    # Query before writing: a session without this service cannot use this setup.
    if query('show', SERVICE, '--property=LoadState', '--value') != 'loaded':
        raise RuntimeError('The GNOME Wayland systemd service was not found for your user.')
    if any(character.isspace() or character in ':"\\' for character in str(LIBRARY)):
        raise RuntimeError('The library installation path cannot contain whitespace, colons, quotes, or backslashes.')

    unit_path = bus_value('o', 'call', MANAGER_PATH, MANAGER_INTERFACE,
                          'GetUnit', 's', SERVICE)
    manager_environment = bus_value('as', 'get-property', MANAGER_PATH,
                                    MANAGER_INTERFACE, 'Environment')
    service_environment = bus_value('as', 'get-property', unit_path,
                                    SERVICE_INTERFACE, 'Environment')
    inherited = next((entry.partition('=')[2] for entry in manager_environment
                      if entry.startswith('LD_PRELOAD=')), '')
    for entry in service_environment:
        if entry.startswith('LD_PRELOAD='):
            inherited = entry.partition('=')[2]
    other_libraries = [entry for entry in inherited.replace(':', ' ').split()
                       if entry != str(LIBRARY)]
    preload = ':'.join([str(LIBRARY), *other_libraries])
    # Escape systemd's quoted assignments and literal percent specifiers.
    preload = preload.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
    content = ('# Installed by Touchpad Scroll Speed.\n'
               '[Service]\nEnvironment="LD_PRELOAD=' + preload + '"\n')
    atomic_write(LIBRARY, (PROJECT / 'dist/libtouchpad-scroll.so').read_bytes(), 0o755)
    atomic_write(DROPIN, content.encode(), 0o644)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    print('Scroll component installed. It will load after you log out and back in.')


def uninstall():
    DROPIN.unlink(missing_ok=True)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    # Keep the library until the next login: the running Shell may still map it.
    print('Scroll component disabled for the next login.')
    print('After signing back in you can remove: ' + str(LIBRARY))


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--uninstall']:
            uninstall()
        elif not sys.argv[1:]:
            install()
        else:
            raise RuntimeError('Usage: python3 install-backend.py [--uninstall]')
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
