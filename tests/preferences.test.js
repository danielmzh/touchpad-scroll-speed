// SPDX-License-Identifier: GPL-2.0-or-later
// Run with ./tests/preferences-smoke.sh for a private Broadway display,
// extension directory, gettext registration and in-memory settings.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {SCHEMA_ID} from '../extension/speed.js';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
    throw new Error('Use GSETTINGS_BACKEND=memory to avoid changing your settings');

// Use independent expected labels to verify the installed gettext catalog.
const expectedLanguage = GLib.getenv('EXPECTED_UI_LANGUAGE') ?? 'en';
const expectedLabels = expectedLanguage === 'es'
    ? {
        Slow: 'Lenta', Normal: 'Normal', Fast: 'Rápida', Reset: 'Restablecer',
        Page: 'Desplazamiento del panel táctil',
        Installation: 'Instrucciones de instalación',
    }
    : {
        Slow: 'Slow', Normal: 'Normal', Fast: 'Fast', Reset: 'Reset',
        Page: 'Touchpad scrolling', Installation: 'Installation instructions',
    };

// The preferences resource runs independently of a GNOME Shell session.
imports.package.init({name: 'gnome-shell', prefix: '/usr', libdir: '/usr/lib'});
imports.package.initFormat();
const resource = Gio.Resource.load(
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
resource._register();

const {ExtensionPreferences} = await import(
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
Adw.init();

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function assertNumber(actual, expected, message) {
    assert(Math.abs(actual - expected) < 1e-12,
        `${message}: expected ${expected}, received ${actual}`);
}

function descendants(widget) {
    const widgets = [widget];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        widgets.push(...descendants(child));
    return widgets;
}

function drainEvents() {
    const context = GLib.MainContext.default();
    while (context.pending())
        context.iteration(false);
}

const extensionPath = GLib.getenv('TEST_EXTENSION_DIR');
assert(extensionPath, 'Use ./tests/preferences-smoke.sh to isolate the extension and its translations');
const extensionDir = Gio.File.new_for_path(extensionPath);
const [loaded, metadataBytes] = extensionDir.get_child('metadata.json').load_contents(null);
assert(loaded, 'Could not load the extension metadata');
const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
metadata.dir = extensionDir;
metadata.path = extensionDir.get_path();
assert(metadata['settings-schema'] === SCHEMA_ID,
    'The metadata does not declare the scrolling schema');
const {default: Preferences} = await import(extensionDir.get_child('prefs.js').get_uri());

// GNOME registers preferences instances before their imported gettext wrapper
// looks up the UUID in the installed module path. Reproduce that registration
// locally without starting a preferences service or contacting the desktop.
const originalLookup = ExtensionPreferences.lookupByUUID;
const registeredPreferences = new Map();
ExtensionPreferences.lookupByUUID = uuid => registeredPreferences.get(uuid) ?? null;

const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    extensionDir.get_child('schemas').get_path(),
    Gio.SettingsSchemaSource.get_default(), false);
const scrollSchema = schemaSource.lookup(SCHEMA_ID, false);
assert(scrollSchema, 'The compiled extension scrolling schema was not found');
const external = new Gio.Settings({settings_schema: scrollSchema});
const pointerSettings = [
    {settings: new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.touchpad'}),
        speed: 0.219, profile: 'flat'},
    {settings: new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'}),
        speed: -0.31, profile: 'adaptive'},
];
for (const pointer of pointerSettings) {
    pointer.settings.set_double('speed', pointer.speed);
    const schema = pointer.settings.settings_schema;
    if (schema.list_keys().includes('accel-profile')) {
        const profileKey = schema.get_key('accel-profile');
        if (profileKey.range_check(new GLib.Variant('s', pointer.profile)))
            pointer.settings.set_string('accel-profile', pointer.profile);
        pointer.profile = pointer.settings.get_string('accel-profile');
    } else {
        pointer.profile = null;
    }
}
drainEvents();

let pointerChanges = 0;
const pointerSignals = pointerSettings.map(({settings}) => ({
    settings,
    id: settings.connect('changed', () => pointerChanges++),
}));
const windows = [];
let constructionChanges = 0;
const constructionSignal = external.connect('changed::scroll-factor',
    () => constructionChanges++);

function buildPreferences() {
    // Observe genuine Gio connections so closing verifies they are released.
    const connections = [];
    const originalConnect = Gio.Settings.prototype.connect;
    Gio.Settings.prototype.connect = function (name, callback) {
        const id = originalConnect.call(this, name, callback);
        if (this.schema_id === SCHEMA_ID)
            connections.push({settings: this, id});
        return id;
    };

    const window = new Adw.PreferencesWindow();
    windows.push(window);
    try {
        const preferences = new Preferences(metadata);
        registeredPreferences.set(preferences.uuid, preferences);
        preferences.fillPreferencesWindow(window);
    } finally {
        Gio.Settings.prototype.connect = originalConnect;
    }

    const widgets = descendants(window);
    assert(widgets.some(widget => widget instanceof Adw.PreferencesPage &&
        widget.title === expectedLabels.Page),
        `The preferences page is not translated correctly (${expectedLanguage})`);
    assert(widgets.some(widget => widget instanceof Gtk.LinkButton &&
        widget.label === expectedLabels.Installation && widget.uri === metadata.url),
        `The installation link is missing or not translated correctly (${expectedLanguage})`);
    const scales = widgets.filter(widget => widget instanceof Gtk.Scale);
    assert(scales.length === 1, 'Preferences must contain one slider');
    const buttons = widgets.filter(widget => widget instanceof Gtk.Button);
    const button = label => {
        const expected = expectedLabels[label];
        const found = buttons.find(widget => widget.get_label() === expected);
        assert(found, `The ${expected} button was not found (${expectedLanguage})`);
        return found;
    };
    assert(!widgets.some(widget => widget instanceof Adw.ComboRow),
        'The scrolling preferences contain an acceleration selector');
    const percentLabel = widgets.find(widget =>
        widget instanceof Gtk.Label && /^\d+ %$/.test(widget.label));
    assert(percentLabel, 'The scrolling percentage indicator is missing');
    assert(connections.length === 2, 'The scrolling synchronization signals are missing');
    for (const connection of connections)
        assert(GObject.signal_handler_is_connected(connection.settings, connection.id),
            'A preferences signal was not connected');

    return {window, scale: scales[0], button, percentLabel, connections};
}

function closePreferences(view) {
    view.window.emit('close-request');
    for (const connection of view.connections)
        assert(!GObject.signal_handler_is_connected(connection.settings, connection.id),
            'Closing preferences left a GSettings connection active');
    view.window.destroy();
    drainEvents();
}

try {
    const existing = 1.072072072072072;
    external.set_double('scroll-factor', existing);
    constructionChanges = 0;
    const first = buildPreferences();
    assertNumber(external.get_double('scroll-factor'), existing,
        'Opening preferences changed the existing scrolling factor');
    assertNumber(first.scale.get_value(), existing,
        'The slider lost precision when reading the scrolling factor');
    assert(first.percentLabel.label === '107 %', 'The percentage does not represent the factor');
    assert(constructionChanges === 0, 'Opening preferences wrote the scrolling setting');
    assertNumber(first.scale.adjustment.lower, 0.05, 'The scrolling minimum is not 5 %');
    assertNumber(first.scale.adjustment.upper, 1.5, 'The scrolling maximum is not 150 %');

    first.scale.set_value(1.31);
    drainEvents();
    assertNumber(external.get_double('scroll-factor'), 1.31,
        'The slider did not save the selected scrolling factor');
    assert(first.percentLabel.label === '131 %', 'Moving the slider did not update the percentage');

    const externalFactor = 0.357142857142857;
    external.set_double('scroll-factor', externalFactor);
    drainEvents();
    assertNumber(first.scale.get_value(), externalFactor,
        'The slider did not reflect the external change precisely');
    assertNumber(external.get_double('scroll-factor'), externalFactor,
        'Synchronizing the external change rounded the setting');
    assert(first.percentLabel.label === '36 %', 'The percentage did not reflect the external change');

    // Exercise actual visible controls independently of the conversion helpers.
    for (const [label, expected, percent] of [
        ['Slow', 0.4, '40 %'], ['Normal', 1, '100 %'], ['Fast', 1.5, '150 %'],
    ]) {
        first.button(label).emit('clicked');
        drainEvents();
        assertNumber(external.get_double('scroll-factor'), expected,
            `The ${label} button did not save its scrolling factor`);
        assertNumber(first.scale.get_value(), expected,
            `The ${label} button did not update the slider`);
        assert(first.percentLabel.label === percent,
            `The ${label} button did not update the percentage`);
    }

    for (const [factor, percent] of [[0.05, '5 %'], [1.5, '150 %']]) {
        first.scale.set_value(factor);
        drainEvents();
        assertNumber(external.get_double('scroll-factor'), factor,
            'The slider did not save a range endpoint');
        assert(first.percentLabel.label === percent,
            'The percentage does not represent a range endpoint');
    }

    first.button('Reset').emit('clicked');
    drainEvents();
    assertNumber(external.get_double('scroll-factor'),
        external.get_default_value('scroll-factor').get_double(),
        'Reset did not restore the default scrolling factor');
    assertNumber(first.scale.get_value(), 1, 'Reset did not update the slider');
    assert(first.percentLabel.label === '100 %', 'Reset did not display the normal speed');

    closePreferences(first);
    external.set_double('scroll-factor', 0.231231231231231);
    drainEvents();

    constructionChanges = 0;
    const second = buildPreferences();
    assertNumber(second.scale.get_value(), 0.231231231231231,
        'Reopening preferences did not reflect the current scrolling factor');
    assert(constructionChanges === 0, 'Reopening preferences wrote the scrolling factor');
    second.scale.set_value(1.4);
    drainEvents();
    assertNumber(external.get_double('scroll-factor'), 1.4,
        'The slider stopped saving after reopening preferences');
    closePreferences(second);

    for (const pointer of pointerSettings) {
        assertNumber(pointer.settings.get_double('speed'), pointer.speed,
            `Scrolling changed the pointer speed in ${pointer.settings.schema_id}`);
        if (pointer.profile !== null)
            assert(pointer.settings.get_string('accel-profile') === pointer.profile,
                `Scrolling changed the acceleration in ${pointer.settings.schema_id}`);
    }
    assert(pointerChanges === 0, 'Preferences wrote pointer settings');

    print(`OK (${expectedLanguage}): actual scrolling preferences, precision, external changes, presets, range, reset, close, reopen and pointer/acceleration isolation with in-memory GSettings.`);
} finally {
    ExtensionPreferences.lookupByUUID = originalLookup;
    registeredPreferences.clear();
    external.disconnect(constructionSignal);
    for (const {settings, id} of pointerSignals)
        settings.disconnect(id);
    for (const window of windows)
        window.destroy();
}
