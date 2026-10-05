// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {
    SCHEMA_ID,
    SCROLL_PRESETS,
    factorToSlider,
    sliderToFactor,
    formatFactor,
} from './speed.js';

export default class TouchpadScrollSpeedExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA_ID);
        this._settingsSignals = [];
        this._presetItems = [];
        this._syncing = false;
        this._leaseSource = 0;
        this._leasePath = GLib.build_filenamev([
            GLib.get_user_runtime_dir(), 'touchpad-scroll-speed.factor',
        ]);
        this._backendReady = false;
        this._backendCancellable = null;

        try {
            this._buildMenu();
            this._settingsSignals.push(
                this._settings.connect('changed::scroll-factor', () => this._sync()),
                this._settings.connect('writable-changed::scroll-factor', () => this._sync())
            );
            this._sync();
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            this._detectBackend();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _detectBackend() {
        if (!Meta.is_wayland_compositor())
            return;

        const cancellable = new Gio.Cancellable();
        this._backendCancellable = cancellable;
        Gio.File.new_for_path('/proc/self/maps').load_contents_async(
            cancellable, (file, result) => {
                let maps;
                try {
                    [, maps] = file.load_contents_finish(result);
                } catch (error) {
                    if (this._backendCancellable === cancellable) {
                        this._backendCancellable = null;
                        if (!cancellable.is_cancelled())
                            console.error(`Could not detect the touchpad scroll component: ${error.message}`);
                    }
                    return;
                }

                // A completed read must belong to the current activation.
                if (cancellable.is_cancelled() || this._backendCancellable !== cancellable)
                    return;

                this._backendCancellable = null;
                this._backendReady =
                    new TextDecoder().decode(maps).includes('/libtouchpad-scroll.so');
                this._statusItem.actor.visible = !this._backendReady;
                this._sync();
                if (this._backendReady) {
                    this._leaseSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                        this._writeLease();
                        return GLib.SOURCE_CONTINUE;
                    });
                }
            }
        );
    }

    _buildMenu() {
        this._indicator = new PanelMenu.Button(0.0, _('Touchpad Scroll Speed'));
        this._indicator.add_child(new St.Icon({
            icon_name: 'input-touchpad-symbolic',
            style_class: 'system-status-icon',
        }));

        const title = new PopupMenu.PopupMenuItem(_('Touchpad scrolling'), {
            reactive: false,
            can_focus: false,
        });
        title.label.add_style_class_name('touchpad-sensitivity-title');
        this._indicator.menu.addMenuItem(title);

        this._statusItem = new PopupMenu.PopupMenuItem(
            Meta.is_wayland_compositor()
                ? _('Install the scroll component from the project, then log out and log back in.')
                : _('A GNOME Wayland session is required.'),
            {reactive: false, can_focus: false}
        );
        this._statusItem.label.clutter_text.line_wrap = true;
        this._statusItem.actor.visible = !this._backendReady;
        this._indicator.menu.addMenuItem(this._statusItem);

        const valueRow = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        valueRow.add_child(new St.Label({
            text: _('Two-finger scrolling'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._valueLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'touchpad-sensitivity-value',
        });
        valueRow.add_child(this._valueLabel);
        this._indicator.menu.addMenuItem(valueRow);

        this._sliderRow = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            can_focus: false,
        });
        this._slider = new Slider.Slider(0);
        this._slider.accessible_name = _('Touchpad scroll speed');
        this._sliderRow.add_child(this._slider);
        this._sliderRow.connect('button-press-event', (_actor, event) =>
            this._slider.startDragging(event));
        this._sliderRow.connect('scroll-event', (_actor, event) =>
            this._slider.scroll(event));
        this._indicator.menu.addMenuItem(this._sliderRow);
        this._slider.connect('notify::value', () => {
            if (!this._syncing)
                this._setFactor(sliderToFactor(this._slider.value));
        });

        const limits = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'touchpad-sensitivity-limits',
        });
        limits.add_child(new St.Label({text: _('Slower'), x_expand: true}));
        limits.add_child(new St.Label({text: _('Faster')}));
        this._indicator.menu.addMenuItem(limits);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (const preset of SCROLL_PRESETS) {
            const item = this._indicator.menu.addAction(
                _('%s · %s').format(_(preset.label), formatFactor(preset.factor)),
                () => this._setFactor(preset.factor)
            );
            this._presetItems.push({item, factor: preset.factor});
        }

        this._resetItem = this._indicator.menu.addAction(
            _('Reset speed'), () => {
                if (this._settings.is_writable('scroll-factor'))
                    this._settings.reset('scroll-factor');
            }, 'edit-undo-symbolic'
        );
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addAction(
            _('Preferences…'), () => this.openPreferences(), 'emblem-system-symbolic'
        );
    }

    _setFactor(factor) {
        if (this._backendReady && this._settings.is_writable('scroll-factor'))
            this._settings.set_double('scroll-factor', sliderToFactor(factorToSlider(factor)));
        this._sync();
    }

    _sync() {
        const factor = this._settings.get_double('scroll-factor');
        const writable = this._backendReady && this._settings.is_writable('scroll-factor');

        // Reading or opening the menu must never write back a rounded value.
        this._syncing = true;
        try {
            this._slider.value = factorToSlider(factor);
        } finally {
            this._syncing = false;
        }
        this._sliderRow.reactive = writable;
        this._sliderRow.track_hover = writable;
        this._slider.reactive = writable;
        this._slider.can_focus = writable;
        this._valueLabel.text = formatFactor(factor);
        this._indicator.accessible_name =
            _('Touchpad scrolling: %s').format(formatFactor(factor));

        for (const preset of this._presetItems) {
            preset.item.setSensitive(writable);
            preset.item.setOrnament(Math.abs(factor - preset.factor) < 0.0001
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        }
        this._resetItem.setSensitive(writable);
        this._writeLease();
    }

    _writeLease() {
        if (!this._backendReady)
            return;

        // Expire automatically if Shell stops renewing the enabled extension.
        const expiry = GLib.get_monotonic_time() + 6_000_000;
        const factor = this._settings.get_double('scroll-factor');
        try {
            GLib.file_set_contents(this._leasePath, `${factor} ${expiry}\n`);
        } catch (error) {
            console.error(`Could not apply touchpad scroll speed: ${error.message}`);
            this._statusItem.label.text = _('Could not apply the scroll speed.');
            this._statusItem.actor.visible = true;
        }
    }

    disable() {
        this._backendCancellable?.cancel();
        this._backendCancellable = null;
        if (this._leaseSource) {
            GLib.Source.remove(this._leaseSource);
            this._leaseSource = 0;
        }
        if (this._leasePath)
            GLib.unlink(this._leasePath);
        this._leasePath = null;

        if (this._settingsSignals) {
            for (const id of this._settingsSignals)
                this._settings.disconnect(id);
        }
        this._settingsSignals = null;

        this._sliderRow?.destroy();
        this._statusItem?.destroy();
        this._valueLabel?.destroy();
        this._indicator?.destroy();
        this._indicator = null;
        this._slider = null;
        this._sliderRow = null;
        this._valueLabel = null;
        this._resetItem = null;
        this._statusItem = null;
        this._presetItems = null;
        this._settings = null;
        this._syncing = false;
        this._backendReady = false;
    }
}
