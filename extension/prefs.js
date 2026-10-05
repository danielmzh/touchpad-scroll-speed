// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    SCHEMA_ID,
    MIN_FACTOR,
    MAX_FACTOR,
    SCROLL_PRESETS,
    formatFactor,
} from './speed.js';

export default class TouchpadScrollPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(680, 520);

        const page = new Adw.PreferencesPage({
            title: _('Touchpad scrolling'),
            icon_name: 'input-touchpad-symbolic',
        });
        window.add(page);

        let settings;
        try {
            settings = this.getSettings(SCHEMA_ID);
        } catch {
            const unavailable = new Adw.PreferencesGroup({
                title: _('Settings unavailable'),
                description: _('Reinstall the extension to restore the scrolling settings.'),
            });
            page.add(unavailable);
            return;
        }

        const settingsSignals = [];
        const speedControls = [];
        let syncingSpeed = false;

        const speedGroup = new Adw.PreferencesGroup({
            title: _('Scrolling speed'),
            description: _('Adjust two-finger scrolling. 100 % is the normal speed.'),
        });
        page.add(speedGroup);

        // Keep the existing fractional value until the user moves the slider.
        const adjustment = new Gtk.Adjustment({
            lower: MIN_FACTOR,
            upper: MAX_FACTOR,
            step_increment: 0.05,
            page_increment: 0.25,
            value: settings.get_double('scroll-factor'),
        });
        const scale = new Gtk.Scale({
            adjustment,
            orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: false,
            digits: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 220,
        });
        scale.set_round_digits(-1);
        scale.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [_('Two-finger scrolling speed; 100 % is the normal speed')]
        );
        speedControls.push(scale);

        const percentLabel = new Gtk.Label({
            label: formatFactor(adjustment.value),
            width_chars: 5,
            xalign: 1,
            valign: Gtk.Align.CENTER,
        });
        percentLabel.add_css_class('numeric');

        const speedRow = new Adw.ActionRow({
            title: _('Scroll speed'),
            subtitle: _('%s: slower · 100 %%: normal · %s: faster')
                .format(formatFactor(MIN_FACTOR), formatFactor(MAX_FACTOR)),
            activatable_widget: scale,
        });
        speedRow.add_suffix(scale);
        speedRow.add_suffix(percentLabel);
        speedGroup.add(speedRow);

        const syncSpeed = () => {
            syncingSpeed = true;
            try {
                const factor = settings.get_double('scroll-factor');
                scale.set_value(factor);
                percentLabel.label = formatFactor(factor);

                const writable = settings.is_writable('scroll-factor');
                for (const control of speedControls)
                    control.sensitive = writable;
            } finally {
                syncingSpeed = false;
            }
        };

        scale.connect('value-changed', () => {
            if (syncingSpeed)
                return;

            if (settings.is_writable('scroll-factor'))
                settings.set_double('scroll-factor', scale.get_value());
            syncSpeed();
        });

        const presetsRow = new Adw.ActionRow({title: _('Quick presets')});
        const presetsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        for (const preset of SCROLL_PRESETS) {
            const button = new Gtk.Button({
                label: _(preset.label),
                tooltip_text: _('Set scrolling to %s').format(formatFactor(preset.factor)),
            });
            button.connect('clicked', () => {
                if (settings.is_writable('scroll-factor'))
                    settings.set_double('scroll-factor', preset.factor);
                syncSpeed();
            });
            speedControls.push(button);
            presetsBox.append(button);
        }
        presetsRow.add_suffix(presetsBox);
        speedGroup.add(presetsRow);

        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            if (settings.is_writable('scroll-factor'))
                settings.reset('scroll-factor');
            syncSpeed();
        });
        speedControls.push(resetButton);

        const resetRow = new Adw.ActionRow({
            title: _('Reset scrolling'),
            subtitle: _('Restore the normal speed (100 %).'),
            activatable_widget: resetButton,
        });
        resetRow.add_suffix(resetButton);
        speedGroup.add(resetRow);

        settingsSignals.push(settings.connect('changed::scroll-factor', syncSpeed));
        settingsSignals.push(settings.connect('writable-changed::scroll-factor', syncSpeed));
        syncSpeed();

        const activationGroup = new Adw.PreferencesGroup({
            title: _('Apply the setting'),
            description: _('Install the scroll component from the project, then log out and log back in. Disabling the extension restores normal speed and keeps your setting.'),
        });
        page.add(activationGroup);

        const installationLink = new Gtk.LinkButton({
            label: _('Installation instructions'),
            uri: this.metadata.url,
            valign: Gtk.Align.CENTER,
        });
        const installationRow = new Adw.ActionRow({
            title: _('Scroll component'),
            subtitle: _('The GNOME Extensions package needs the scroll component installed separately.'),
            activatable_widget: installationLink,
        });
        installationRow.add_suffix(installationLink);
        activationGroup.add(installationRow);

        window.connect('close-request', () => {
            for (const id of settingsSignals.splice(0))
                settings.disconnect(id);
            return false;
        });
    }
}
