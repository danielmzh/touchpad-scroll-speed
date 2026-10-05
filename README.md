# Touchpad Scroll Speed

Adjust vertical and horizontal **two-finger touchpad scrolling** on **GNOME Shell
48 with Wayland**. Tested on Debian 13. The extension adds a touchpad icon to the
top bar and a preferences window in the Extensions app.

Project: [danielmzh/touchpad-scroll-speed](https://github.com/danielmzh/touchpad-scroll-speed).

## Features

- Scroll speed from **5% to 150%** of normal speed.
- Presets: **Slow: 40%**, **Normal: 100%**, **Fast: 150%**.
- Reset restores **100%**.
- English and Spanish interface, selected automatically from your system language.
- The top-bar menu and preferences share the same saved setting.

The percentage multiplies the scroll distance: 40% reduces it, and 150% increases
it to one and a half times normal. Changes apply to the next gesture. Applications
may add their own scrolling or inertia. Pointer speed, pointer acceleration,
mouse wheel scrolling, and GNOME's scroll direction setting are preserved.

Disabling the extension restores normal scrolling and keeps your saved speed.

## Install or update

The native scroll component is required. **Installing only the GNOME extension
ZIP does not enable scroll adjustment.** Download and extract the complete source
release from GitHub, or clone the repository:

```bash
git clone https://github.com/danielmzh/touchpad-scroll-speed.git
cd touchpad-scroll-speed
```

Requirements: GNOME Shell 48 on Wayland, a user session managed by systemd,
Python 3, a C compiler, `pkg-config`, libinput development headers, and either
GNU gettext or Python Babel. On Debian 13, install the build dependencies:

```bash
sudo apt install build-essential pkg-config libinput-dev gnome-shell python3 gettext
```

Then run from the project directory, **without sudo**:

```bash
./install.sh
```

The installer builds the native component and installs the extension for your
user. **Save your work, log out, and sign back in** to load the scroll component.
In the Extensions app, enable **Touchpad Scroll Speed** under **Installed**.

The public UUID is `touchpad-scroll-speed@danielmzh.github.io`. When updating from
the local prototype, the installer disables `sensibilidad-touchpad@local` to
prevent both versions from using the same scroll file. The saved speed and
pointer settings are preserved. A saved factor outside the new range falls back
to the default of 100% through GSettings schema validation.

After signing back in, you can also run:

```bash
gnome-extensions enable touchpad-scroll-speed@danielmzh.github.io
gnome-extensions prefs touchpad-scroll-speed@danielmzh.github.io
```

If the menu reports a missing component, run the installer and sign back in.
The interface uses English as its default and Spanish when your session language
is Spanish. Restart the session after changing the system language.

## How it works

This extension stores its own `scroll-factor`. A small native library multiplies
libinput touchpad scroll events before Mutter passes them to applications. GNOME's
`org.gnome.desktop.peripherals.touchpad speed` setting controls pointer movement
and is not used for scrolling.

The component intercepts `LIBINPUT_EVENT_POINTER_SCROLL_FINGER` inside
`gnome-shell`. It preserves zero values at the end of a gesture and the signs of
both axes. Wheel events, pointer motion, zoom, and three-finger gestures are
unchanged.

The library is installed at `~/.local/lib/touchpad-scroll/libtouchpad-scroll.so`.
A user systemd drop-in at
`~/.config/systemd/user/org.gnome.Shell@wayland.service.d/80-touchpad-scroll.conf`
loads it only in GNOME's Wayland service. Existing preload libraries are retained,
and the component removes its own `LD_PRELOAD` entry from child processes. This
requires a GNOME session managed by systemd, such as Debian 13's default session.

While enabled, the extension renews a temporary file at
`$XDG_RUNTIME_DIR/touchpad-scroll-speed.factor`. Disabling it removes the file.
If renewal stops, scrolling returns to normal within six seconds. Installation
requires no root access and does not replace system libraries.

## Build, verify, and package

```bash
./build-backend.sh
./package.sh
GSETTINGS_BACKEND=memory gjs -m tests/speed.test.js
bash tests/backend.test.sh
python3 tests/install-backend.test.py
./tests/preferences-smoke.sh
python3 tests/shell-smoke.py
python3 tests/shell-smoke.py --without-backend
python3 tests/shell-smoke.py --language es
./release.sh
```

The GNOME ZIP is `dist/touchpad-scroll-speed@danielmzh.github.io.shell-extension.zip`.
It contains the interface, schema, translation catalog, and license. The native
library and installer stay outside that ZIP. The full source archive is
`dist/touchpad-scroll-speed-1.0.0.tar.gz`; `dist/SHA256SUMS` covers both archives.
Use the full source archive for GitHub releases and only the extension ZIP for
GNOME submission.

Tests use memory-backed settings, isolated displays, and temporary directories.
The bilingual UI tests require the `en_US.UTF-8` and `es_CL.UTF-8` locales. Check
with `locale -a` and enable them through your distribution's locale configuration
if needed; this requirement is only for running the tests.
They cover real controls in English and Spanish, precision, synchronization,
reset, extension lifecycle, lease renewal, and pointer/mouse isolation. The
backend tests use simulated input with libinput's dynamic linkage. Shell tests use
a separate headless GNOME session. Check the final scrolling feel with a physical
touchpad after signing back in.

## Translations

English strings are in the JavaScript source; Spanish translations are in
`po/es.po`. `./package.sh` compiles catalogs with `msgfmt`, or Python Babel when
gettext is unavailable. To update the translation template with GNU gettext:

```bash
xgettext --language=JavaScript --from-code=UTF-8 --keyword=_ --keyword=N_ \
  --package-name=touchpad-scroll-speed --package-version=1.0.0 \
  --output=po/touchpad-scroll-speed.pot \
  extension/extension.js extension/prefs.js extension/speed.js
msgmerge --update po/es.po po/touchpad-scroll-speed.pot
```

## Uninstall

```bash
gnome-extensions disable touchpad-scroll-speed@danielmzh.github.io
gnome-extensions uninstall touchpad-scroll-speed@danielmzh.github.io
python3 install-backend.py --uninstall
```

Log out and sign back in. You can then remove
`~/.local/lib/touchpad-scroll/`. Your saved speed remains available for a later
installation.

## References and license

- [Mutter 48.7 scroll handling](https://github.com/GNOME/mutter/blob/48.7/src/backends/native/meta-seat-impl.c).
- [GNOME extension preferences and schemas](https://gjs.guide/extensions/development/preferences.html).
- [GNOME extension translations](https://gjs.guide/extensions/development/translations.html).
- [libinput API](https://wayland.freedesktop.org/libinput/doc/latest/api/).

Licensed under **GPL-2.0-or-later**. See [LICENSE](LICENSE).
