#!/usr/bin/env python3
"""Exercise the extension in a private headless GNOME Shell session.

All settings and desktop data are isolated. The private bus has no service
activation directories, and the test never connects to the active session.
Run from this repository as: python3 tests/shell-smoke.py
An optional first argument selects another extension source directory.
Use --without-backend to verify the disabled controls before session activation.
Use --language es to verify the Spanish translation in GNOME Shell.
Logs and copied artifacts remain in the reported temporary directory.
"""

import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

UUID = 'touchpad-scroll-speed@danielmzh.github.io'
SOURCE = Path(__file__).resolve().parent.parent / 'extension'
UI_LABELS = {
    'en': {
        'title': 'Touchpad scrolling',
        'slider': 'Touchpad scroll speed',
        'status': 'Install the scroll component from the project, then log out and log back in.',
        'presets': ['Slow · 40 %', 'Normal · 100 %', 'Fast · 150 %'],
        'reset': 'Reset speed',
        'preferences': 'Preferences…',
    },
    'es': {
        'title': 'Desplazamiento del panel táctil',
        'slider': 'Velocidad de desplazamiento del panel táctil',
        'status': 'Instala el componente de desplazamiento desde el proyecto; luego cierra sesión y vuelve a entrar.',
        'presets': ['Lenta · 40 %', 'Normal · 100 %', 'Rápida · 150 %'],
        'reset': 'Restablecer velocidad',
        'preferences': 'Preferencias…',
    },
}

def bus_call(method, *args, timeout=6):
    result = subprocess.run([
        'gdbus', 'call', '--session', '--dest', 'org.gnome.Shell',
        '--object-path', '/org/gnome/Shell', '--method', method, *args,
    ], text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout.strip()

def evaluate(code, timeout=6):
    # gdbus parses arguments as GVariant text, so quote the JavaScript string
    # explicitly to preserve literal backslashes in regular expressions.
    result = bus_call('org.gnome.Shell.Eval', json.dumps(code, ensure_ascii=False), timeout=timeout)
    transformed = result.replace('(true,', '(True,', 1).replace('(false,', '(False,', 1)
    ok, value = ast.literal_eval(transformed)
    if not ok:
        raise RuntimeError('Eval failed: ' + value)
    return json.loads(value) if value else None

def inside(base, without_backend=False):
    env = os.environ.copy()
    expected_ui = UI_LABELS[env['LANGUAGE']]
    env['DBUS_SYSTEM_BUS_ADDRESS'] = env['DBUS_SESSION_BUS_ADDRESS']
    # Load the interposer only in Shell, never in Python or its gdbus children.
    env.pop('LD_PRELOAD', None)
    if not without_backend:
        env['LD_PRELOAD'] = str(base / 'libtouchpad-scroll.so')
    log_path = base / 'shell.log'
    with log_path.open('w') as log:
        shell = subprocess.Popen([
            'gnome-shell', '--headless', '--wayland', '--no-x11',
            '--virtual-monitor=1280x800', '--unsafe-mode', '--debug-control',
        ], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if shell.poll() is not None:
                    raise RuntimeError('Shell exited: ' + str(shell.returncode))
                try:
                    if evaluate("(async()=>{ const Main=await import('resource:///org/gnome/shell/ui/main.js'); return global.context.unsafe_mode&&!Main.layoutManager._startingUp&&Main.layoutManager.primaryIndex>=0; })()") is True:
                        break
                except (RuntimeError, subprocess.TimeoutExpired):
                    pass
                time.sleep(0.3)
            else:
                raise RuntimeError('Shell did not become ready')
            print('isolated_shell_ready', flush=True)
            backend_loaded = 'libtouchpad-scroll.so' in Path(f'/proc/{shell.pid}/maps').read_text()
            if backend_loaded == without_backend:
                raise RuntimeError('Unexpected scroll backend mapping: ' + str(backend_loaded))
            print('backend_loaded', backend_loaded, flush=True)
            print('enable_request', evaluate("(async()=> { const Main=await import('resource:///org/gnome/shell/ui/main.js'); await Main.extensionManager._initializationPromise; global.settings.set_boolean('disable-user-extensions',false); return Main.extensionManager.enableExtension('" + UUID + "'); })()"), flush=True)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                state = evaluate("(async()=> { const Main=await import('resource:///org/gnome/shell/ui/main.js'); const e=Main.extensionManager.lookup('" + UUID + "'); return {state:e?.state, errors:e?.errors, panel:!!Main.panel.statusArea['" + UUID + "']}; })()")
                if state.get('panel'):
                    break
                if state.get('errors'):
                    raise RuntimeError('Extension errors: ' + json.dumps(state))
                time.sleep(0.2)
            else:
                raise RuntimeError('Extension not enabled: ' + json.dumps(state))
            print('enabled_state', json.dumps(state), flush=True)
            results = evaluate(r"""(async()=> {
                const Main=await import('resource:///org/gnome/shell/ui/main.js');
                const {default:Gio}=await import('gi://Gio');
                const {default:GLib}=await import('gi://GLib');
                const {default:Atk}=await import('gi://Atk');
                const wait=ms=>new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
                const uuid='touchpad-scroll-speed@danielmzh.github.io';
                const expectedUi=EXPECTED_UI;
                let e=Main.extensionManager.lookup(uuid).stateObj;
                const s=e._settings;
                const touchpad=new Gio.Settings({schema_id:'org.gnome.desktop.peripherals.touchpad'});
                const mouse=new Gio.Settings({schema_id:'org.gnome.desktop.peripherals.mouse'});
                touchpad.set_double('speed',0.27182818);
                touchpad.set_string('accel-profile','flat');
                mouse.set_double('speed',-0.31);
                mouse.set_string('accel-profile','flat');
                const pointerSnapshot=()=>[touchpad.get_double('speed'),touchpad.get_string('accel-profile'),mouse.get_double('speed'),mouse.get_string('accel-profile')];
                const originalPointers=pointerSnapshot();
                const assertions=[];
                const check=(name,pass,value)=>{ assertions.push({name,pass,value}); if (!pass) throw new Error(name+': '+JSON.stringify(value)); };
                const near=(a,b)=>Math.abs(a-b)<1e-8;
                const checkPointers=operation=>check('pointer settings unchanged after '+operation,JSON.stringify(pointerSnapshot())===JSON.stringify(originalPointers),pointerSnapshot());
                const leasePath=GLib.build_filenamev([GLib.get_user_runtime_dir(),'touchpad-scroll-speed.factor']);
                const leaseFile=Gio.File.new_for_path(leasePath);
                const readLease=()=>{
                    const [ok,contents]=leaseFile.load_contents(null);
                    if (!ok) throw new Error('Cannot read scroll lease');
                    const text=new TextDecoder().decode(contents);
                    const fields=text.trim().split(/\s+/).map(Number);
                    return {text,factor:fields[0],expires:fields[1]};
                };
                const checkLease=(name,factor)=>{
                    const lease=readLease();
                    const remaining=lease.expires-GLib.get_monotonic_time();
                    check(name,near(lease.factor,factor)&&remaining>3000000&&remaining<=6000000&&/^\S+ \d+\n$/.test(lease.text),lease);
                    return lease;
                };
                const labelTexts=actor=>[...(typeof actor.text==='string'?[actor.text]:[]),...actor.get_children().flatMap(labelTexts)];
                const menuLabels=labelTexts(e._indicator.menu.actor);
                check('scroll labels describe scrolling',menuLabels.includes(expectedUi.title),menuLabels);
                check('menu actions use expected language',menuLabels.includes(expectedUi.reset)&&menuLabels.includes(expectedUi.preferences),menuLabels);
                const presetLabels=e._presetItems.map(p=>p.item.label.text);
                check('preset labels use expected language',JSON.stringify(presetLabels)===JSON.stringify(expectedUi.presets),presetLabels);
                check('initial factor and slider',near(s.get_double('scroll-factor'),1)&&near(e._slider.value,0.95/1.45)&&e._valueLabel.text==='100 %',[s.get_double('scroll-factor'),e._slider.value,e._valueLabel.text]);
                check('backend availability matches session',e._backendReady===BACKEND_EXPECTED,e._backendReady);
                if (!BACKEND_EXPECTED) {
                    check('missing backend disables controls',!e._sliderRow.reactive&&!e._slider.reactive&&!e._slider.can_focus&&e._presetItems.every(p=>!p.item.reactive)&&!e._resetItem.reactive,[e._sliderRow.reactive,e._slider.reactive,e._slider.can_focus]);
                    check('missing backend displays session instruction',e._statusItem.label.text===expectedUi.status,e._statusItem.label.text);
                    check('missing backend has no lease',!leaseFile.query_exists(null),leasePath);
                    e._setFactor(1.5);
                    check('missing backend rejects changes',near(s.get_double('scroll-factor'),1)&&!leaseFile.query_exists(null),s.get_double('scroll-factor'));
                    Main.extensionManager.disableExtension(uuid);
                    check('disable missing backend clears resources',e._settings===null&&e._settingsSignals===null&&e._indicator===null&&e._leaseSource===0,[e._settings,e._settingsSignals,e._indicator,e._leaseSource]);
                    checkPointers('missing backend lifecycle');
                    return assertions;
                }
                check('slider row remains interactive',e._sliderRow.reactive&&e._slider.reactive&&e._slider.can_focus,[e._sliderRow.reactive,e._slider.reactive,e._slider.can_focus]);
                checkLease('initial live scroll factor',1);
                e._slider.value=0.8;
                check('slider writes scroll factor',near(s.get_double('scroll-factor'),1.21),s.get_double('scroll-factor'));
                checkLease('slider changes live scroll factor',1.21);
                checkPointers('slider');
                s.set_double('scroll-factor',0.4);
                check('external settings sync',near(e._slider.value,0.35/1.45)&&e._valueLabel.text==='40 %',[e._slider.value,e._valueLabel.text]);
                checkLease('external setting changes live scroll factor',0.4);
                checkPointers('external scroll setting');
                for (const p of e._presetItems) {
                    p.item.emit('activate',null);
                    check('preset '+p.factor,near(s.get_double('scroll-factor'),p.factor),s.get_double('scroll-factor'));
                    checkLease('preset live factor '+p.factor,p.factor);
                    checkPointers('preset '+p.factor);
                }
                e._resetItem.emit('activate',null);
                check('reset scroll factor',near(s.get_double('scroll-factor'),1),s.get_double('scroll-factor'));
                checkLease('reset restores normal scrolling',1);
                checkPointers('reset');
                s.set_double('scroll-factor',1.23456789);
                e._indicator.menu.open(false); await wait(150);
                check('menu and slider have visible geometry',e._indicator.menu.actor.width>200&&e._slider.width>100&&e._slider.height>0,[e._indicator.menu.actor.width,e._slider.width,e._slider.height]);
                check('slider exposes accessibility',e._slider.accessible_role===Atk.Role.SLIDER&&e._slider.accessible_name===expectedUi.slider,[e._slider.accessible_role,e._slider.accessible_name]);
                e._indicator.menu.close(false); await wait(150);
                check('opening menu preserves exact value',near(s.get_double('scroll-factor'),1.23456789),s.get_double('scroll-factor'));
                checkPointers('menu');
                const beforeRefresh=checkLease('exact factor in lease',1.23456789);
                await wait(2700);
                const afterRefresh=checkLease('lease remains live',1.23456789);
                check('timer renews lease',afterRefresh.expires>beforeRefresh.expires+1000000,[beforeRefresh.expires,afterRefresh.expires]);
                const original=e._indicator;
                Main.extensionManager.disableExtension(uuid);
                check('disable removes panel',!Main.panel.statusArea[uuid],Object.keys(Main.panel.statusArea));
                check('disable clears resources',e._settings===null&&e._settingsSignals===null&&e._indicator===null&&e._slider===null&&e._leaseSource===0,[e._settings,e._settingsSignals,e._indicator,e._slider,e._leaseSource]);
                check('disable removes lease for normal scrolling',!leaseFile.query_exists(null),leasePath);
                check('disable preserves saved factor',near(s.get_double('scroll-factor'),1.23456789),s.get_double('scroll-factor'));
                checkPointers('disable');
                s.set_double('scroll-factor',0.33333333);
                await wait(2300);
                check('disabled signals and timer stay released',!leaseFile.query_exists(null)&&e._settings===null&&e._settingsSignals===null,[leaseFile.query_exists(null),e._settingsSignals]);
                Main.extensionManager.enableExtension(uuid);
                await wait(300);
                e=Main.extensionManager.lookup(uuid).stateObj;
                check('reenable creates new indicator',!!Main.panel.statusArea[uuid]&&e._indicator!==original,!!Main.panel.statusArea[uuid]);
                check('reenable reads saved factor',near(e._slider.value,(0.33333333-0.05)/1.45),e._slider.value);
                checkLease('reenable activates saved factor',0.33333333);
                const signalCount=e._settingsSignals.length;
                check('reenable owns two settings signals',signalCount===2,signalCount);
                checkPointers('reenable');
                e._indicator.menu.open(false); await wait(150);
                Main.extensionManager.disableExtension(uuid);
                await wait(400);
                check('disable open menu clears panel',!Main.panel.statusArea[uuid],!!Main.panel.statusArea[uuid]);
                check('disable open menu removes lease',!leaseFile.query_exists(null),leasePath);
                checkPointers('disable with menu open');
                return assertions;
            })()""".replace('BACKEND_EXPECTED', 'false' if without_backend else 'true')
                .replace('EXPECTED_UI', json.dumps(expected_ui, ensure_ascii=False)), timeout=15)
            print('assertions', json.dumps(results), flush=True)
            (base / 'assertions.json').write_text(json.dumps(results, indent=2) + '\n')
        finally:
            if shell.poll() is None:
                shell.terminate()
                try:
                    shell.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    shell.kill()
                    shell.wait(timeout=5)
    print('shell_log', str(log_path), flush=True)
    log_contents = log_path.read_text()
    markers = ['JS ERROR', 'Gjs-CRITICAL', 'St-CRITICAL', 'CSS parsing error']
    errors = [line for line in log_contents.splitlines() if any(marker in line for marker in markers)]
    if errors:
        raise RuntimeError('Shell runtime errors: ' + '\n'.join(errors))
    print('extension_runtime_errors', 0, flush=True)
    return 0

def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--inside':
        return inside(Path(sys.argv[2]), '--without-backend' in sys.argv[3:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path, default=SOURCE)
    parser.add_argument('--without-backend', action='store_true')
    parser.add_argument('--language', choices=UI_LABELS, default='en')
    args = parser.parse_args()
    source = args.source.resolve()
    if not (source / 'metadata.json').exists():
        raise RuntimeError('Extension sources are not ready')
    backend = source.parent / 'dist' / 'libtouchpad-scroll.so'
    if not args.without_backend and not backend.exists():
        raise RuntimeError('Build the scroll backend first: ./build-backend.sh')
    base = Path(tempfile.mkdtemp(prefix='touchpad-shell-smoke-'))
    for name in ['data','config','cache','runtime']:
        (base / name).mkdir(mode=0o700)
    target = base / 'data' / 'gnome-shell' / 'extensions' / UUID
    shutil.copytree(source, target)
    subprocess.run(['glib-compile-schemas', '--strict', str(target / 'schemas')], check=True)
    if not args.without_backend:
        shutil.copy2(backend, base / 'libtouchpad-scroll.so')
    bus_config = base / 'dbus-session.conf'
    bus_config.write_text('''<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=''' + str(base/'runtime') + '''</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
    <allow own="*"/>
  </policy>
</busconfig>
''')
    env = os.environ.copy()
    for key in ['DISPLAY','WAYLAND_DISPLAY','GNOME_SETUP_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','DBUS_STARTER_ADDRESS','DBUS_STARTER_BUS_TYPE']:
        env.pop(key, None)
    env.pop('LD_PRELOAD', None)
    env.update({
        'GSETTINGS_BACKEND':'memory',
        'LC_ALL':'es_CL.UTF-8' if args.language == 'es' else 'en_US.UTF-8',
        'LANGUAGE':args.language,
        'XDG_DATA_HOME':str(base/'data'), 'XDG_CONFIG_HOME':str(base/'config'),
        'XDG_CACHE_HOME':str(base/'cache'), 'XDG_RUNTIME_DIR':str(base/'runtime'),
        'XDG_DATA_DIRS':'/usr/share/gnome:/usr/local/share:/usr/share',
        'XDG_SESSION_TYPE':'wayland', 'GNOME_SHELL_SESSION_MODE':'user',
        'LIBGL_ALWAYS_SOFTWARE':'1','GALLIUM_DRIVER':'llvmpipe','MESA_SHADER_CACHE_DISABLE':'true',
    })
    print('isolated_test_directory', str(base), flush=True)
    command = ['dbus-run-session','--config-file='+str(bus_config),'--',sys.executable,__file__,'--inside',str(base)]
    if args.without_backend:
        command.append('--without-backend')
    result = subprocess.run(command, env=env, timeout=85)
    print('exit',result.returncode,flush=True)
    if result.returncode:
        print((base/'shell.log').read_text()[-10000:] if (base/'shell.log').exists() else 'No shell log',flush=True)
    return result.returncode

if __name__ == '__main__':
    sys.exit(main())
