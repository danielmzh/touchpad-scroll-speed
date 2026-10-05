#!/usr/bin/env python3
"""Compile gettext catalogs with GNU msgfmt or Python Babel."""

from pathlib import Path
import shutil
import subprocess
import sys

PROJECT = Path(__file__).resolve().parent
DOMAIN = 'touchpad-scroll-speed'


def main():
    compiler = shutil.which('msgfmt')
    for source in sorted((PROJECT / 'po').glob('*.po')):
        target = PROJECT / 'extension/locale' / source.stem / 'LC_MESSAGES' / (DOMAIN + '.mo')
        target.parent.mkdir(parents=True, exist_ok=True)
        if compiler:
            subprocess.run([compiler, '--check', '--output-file', str(target), str(source)], check=True)
        else:
            try:
                from babel.messages.pofile import read_po
                from babel.messages.mofile import write_mo
            except ImportError as error:
                raise RuntimeError('Install gettext or python3-babel to compile translations.') from error
            with source.open('rb') as stream:
                catalog = read_po(stream, locale=source.stem, abort_invalid=True)
            # Babel infers Python placeholders in literal UI text such as
            # "100 % is". Only JavaScript format strings need that check here.
            for message in catalog:
                if 'javascript-format' not in message.flags:
                    message.flags.discard('python-format')
            errors = list(catalog.check())
            if errors:
                raise RuntimeError(f'Invalid translation catalog {source}: {errors}')
            with target.open('wb') as stream:
                write_mo(stream, catalog, use_fuzzy=False)
        print(f'Translation compiled: {source.stem}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
