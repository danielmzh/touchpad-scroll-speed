/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <libinput.h>

struct libinput_event {
    enum libinput_event_type type;
};

struct libinput_event_pointer {
    struct libinput_event base;
    double horizontal;
    double vertical;
};
