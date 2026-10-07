#!/usr/bin/env python3
"""Checks that a recording plays in GStreamer, the engine behind GNOME Videos (Totem).

Prerolls the file through playbin with fake sinks, which exercises the same demuxer
and decoder selection a desktop player uses. Prints the duration and exits 0 on
success; prints the GStreamer error and exits 1 on failure; exits 2 if GStreamer's
Python bindings are not installed (Debian/Ubuntu: python3-gi gir1.2-gstreamer-1.0
gstreamer1.0-plugins-good).

    python3 scripts/gst-play.py recording.webm
"""

import sys

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as e:
    print(f"GStreamer bindings unavailable: {e}")
    sys.exit(2)

Gst.init([])
player = Gst.ElementFactory.make("playbin", None)
player.set_property("uri", Gst.filename_to_uri(sys.argv[1]))
player.set_property("video-sink", Gst.ElementFactory.make("fakesink", None))
player.set_property("audio-sink", Gst.ElementFactory.make("fakesink", None))

loop = GLib.MainLoop()
result = {"code": 1}


def on_message(_bus, msg):
    if msg.type == Gst.MessageType.ERROR:
        err, _debug = msg.parse_error()
        print(f"error: {err.message}")
        loop.quit()
    elif msg.type == Gst.MessageType.ASYNC_DONE:
        ok, duration = player.query_duration(Gst.Format.TIME)
        print(f"plays, duration {duration / 1e9:.2f}s" if ok else "plays, duration unknown")
        result["code"] = 0
        loop.quit()


def on_timeout():
    print("error: timed out before the first frame")
    loop.quit()
    return False


bus = player.get_bus()
bus.add_signal_watch()
bus.connect("message", on_message)
GLib.timeout_add_seconds(15, on_timeout)
player.set_state(Gst.State.PAUSED)
loop.run()
player.set_state(Gst.State.NULL)
sys.exit(result["code"])
