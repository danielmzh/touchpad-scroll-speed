// SPDX-License-Identifier: GPL-2.0-or-later

export const SCHEMA_ID = 'org.gnome.shell.extensions.touchpad-scroll-speed';
export const MIN_FACTOR = 0.05;
export const MAX_FACTOR = 1.5;

// Mark shared labels for extraction; translate them in each UI's gettext domain.
const N_ = message => message;

export const SCROLL_PRESETS = [
    {label: N_('Slow'), factor: 0.4},
    {label: N_('Normal'), factor: 1},
    {label: N_('Fast'), factor: 1.5},
];

function clamp(value, min, max) {
    if (!Number.isFinite(value))
        throw new TypeError('Speed must be a finite number');

    return Math.min(max, Math.max(min, value));
}

export function factorToSlider(factor) {
    return (clamp(factor, MIN_FACTOR, MAX_FACTOR) - MIN_FACTOR) /
        (MAX_FACTOR - MIN_FACTOR);
}

export function sliderToFactor(value) {
    return clamp(value, 0, 1) * (MAX_FACTOR - MIN_FACTOR) + MIN_FACTOR;
}

export function formatFactor(factor) {
    return `${Math.round(clamp(factor, MIN_FACTOR, MAX_FACTOR) * 100)} %`;
}
