/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "backend-mock.h"

double
libinput_event_pointer_get_scroll_value(struct libinput_event_pointer *event,
                                       enum libinput_pointer_axis axis)
{
    return axis == LIBINPUT_POINTER_AXIS_SCROLL_HORIZONTAL ?
           event->horizontal : event->vertical;
}

struct libinput_event *
libinput_event_pointer_get_base_event(struct libinput_event_pointer *event)
{
    return &event->base;
}

enum libinput_event_type
libinput_event_get_type(struct libinput_event *event)
{
    return event->type;
}
