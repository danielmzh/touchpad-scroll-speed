// SPDX-License-Identifier: GPL-2.0-or-later
// Run with GSETTINGS_BACKEND=memory gjs -m tests/speed.test.js.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    SCHEMA_ID, SCROLL_PRESETS, factorToSlider, sliderToFactor, formatFactor,
} from '../extension/speed.js';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
    throw new Error('Use GSETTINGS_BACKEND=memory to avoid changing your settings');

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const schemaDir = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_child('extension/schemas').get_path();
const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir, Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup(SCHEMA_ID, false);
assert(schema, 'The compiled scrolling schema is missing');
const settings = new Gio.Settings({settings_schema: schema});
const observer = new Gio.Settings({settings_schema: schema});
const touchpad = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.touchpad'});
const mouse = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'});
touchpad.set_double('speed', 0.27);
touchpad.set_string('accel-profile', 'flat');
mouse.set_double('speed', -0.31);
let changes = 0;
const signal = observer.connect('changed::scroll-factor', () => changes++);

for (let percent = 5; percent <= 150; percent++) {
    const factor = percent / 100;
    assert(settings.set_double('scroll-factor', factor), `GSettings rejected ${factor}`);
    assert(Math.abs(observer.get_double('scroll-factor') - factor) < 1e-12,
        `The factor ${factor} did not synchronize`);
    assert(Math.abs(sliderToFactor(factorToSlider(factor)) - factor) < 1e-12,
        `The slider lost precision: ${factor}`);
}
assert(changes > 0, 'The observer did not receive external changes');
const key = schema.get_key('scroll-factor');
for (const invalid of [-1, 0, 0.049, 1.501, 2, 10])
    assert(!key.range_check(new GLib.Variant('d', invalid)), `The schema accepts ${invalid}`);

assert(JSON.stringify(SCROLL_PRESETS) === JSON.stringify([
    {label: 'Slow', factor: 0.4},
    {label: 'Normal', factor: 1},
    {label: 'Fast', factor: 1.5},
]), 'The presets do not respect the 5 % to 150 % range');
for (const preset of SCROLL_PRESETS) {
    settings.set_double('scroll-factor', preset.factor);
    assert(formatFactor(observer.get_double('scroll-factor')) ===
        `${preset.factor * 100} %`, `Incorrect preset: ${preset.label}`);
}
assert(sliderToFactor(-1) === 0.05 && sliderToFactor(2) === 1.5,
    'The slider bounds are not enforced');
for (const invalid of [NaN, Infinity, -Infinity, '50', null]) {
    let rejected = false;
    try {
        factorToSlider(invalid);
    } catch (error) {
        rejected = error instanceof TypeError;
    }
    assert(rejected, `Invalid value accepted: ${invalid}`);
}

settings.reset('scroll-factor');
assert(observer.get_double('scroll-factor') === 1, 'Reset does not restore factor 1');
assert(touchpad.get_double('speed') === 0.27 && touchpad.get_string('accel-profile') === 'flat',
    'Scrolling changed the pointer speed or acceleration');
assert(mouse.get_double('speed') === -0.31, 'Scrolling changed the mouse speed');
observer.disconnect(signal);
print('OK: scrolling schema, range, precision, presets, synchronization and reset; pointer and mouse settings unchanged.');
