#!/usr/bin/env python3
"""StopFailure hook: when a usage limit stops a turn, push a notification as each cap it reports resets.
A detached `--watch` copy reads the caps from the transcript, sleeps until each reset and posts to ntfy."""

import json
import os
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

from limitwatch import (
    MARGIN,
    Cap,
    Intent,
    announcement,
    claim,
    describe_caps,
    effective_topic,
    hand_over,
    lookup,
    release,
    sleep_until,
    stored_topic,
    subscribe_steps,
    try_open,
)
from limitwatch import push as ntfy_push

# Both overridable so the whole path can be tested against a local server.
DIR = Path(os.environ.get('PORTAVOCE_DIR') or Path.home() / '.claude' / 'portavoce')
NTFY_URL = (os.environ.get('PORTAVOCE_NTFY_URL') or 'https://ntfy.sh').rstrip('/') + '/'
TOPIC_PREFIX = 'claude-portavoce'
ICON_URL = 'https://raw.githubusercontent.com/carlocontaldi/claude-portavoce/main/assets/portavoce-icon-64.png'
LOOKUP_TRIES = 10  # the limit error may not be in the transcript yet when the hook fires
GROUP = 120  # seconds: caps resetting this close together are announced in one push


def log(msg):
    fd = os.open(DIR / 'log.txt', os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'a') as f:
        f.write(f'{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S}Z {msg}\n')


def read_settings():
    names = ('ntfy_topic', 'notify_email', 'ntfy_token')
    settings = {n: os.environ.get(f'CLAUDE_PLUGIN_OPTION_{n.upper()}', '').strip() for n in names}
    settings['ntfy_topic'] = effective_topic(settings['ntfy_topic'], DIR / 'topic', TOPIC_PREFIX)
    return settings


def reset_groups(caps: list[Cap]) -> list[list[Cap]]:
    """Caps by reset time, those resetting within GROUP seconds of the previous one together."""
    groups: list[list[Cap]] = []
    for cap in sorted(caps, key=lambda c: c.reset):
        if groups and (cap.reset - groups[-1][-1].reset).total_seconds() <= GROUP:
            groups[-1].append(cap)
        else:
            groups.append([cap])
    return groups


def push(text, settings, with_email=True):
    ntfy_push(
        NTFY_URL,
        settings['ntfy_topic'],
        text,
        log,
        title='🦜✅ Claude limit restored',
        icon=ICON_URL,
        email=settings['notify_email'] if with_email else '',
        token=settings['ntfy_token'],
        signature='Claude Portavoce',
    )


def announce(group: list[Cap], later: list[Cap], settings) -> None:
    reset = group[-1].reset
    marker = DIR / f'{int(group[0].reset.timestamp())}.lock'
    fd = claim(marker)
    if fd is None:
        log(f'already watching the {reset:%Y-%m-%d %H:%M}Z reset')
        return
    try:
        log(f'{describe_caps(group)}; will push at {reset + MARGIN:%Y-%m-%d %H:%M:%S}Z')
        at = reset + MARGIN
        intent = try_open(Intent(at, settings['notify_email']), log)  # tells a Goon about to email that this is coming
        try:
            sleep_until(at)
            pending = [cap for cap in later if cap.reset > reset]
            text = announcement(group, pending)
            phone_only = partial(push, text, settings, with_email=False)
            emailed_by_goon = hand_over(at, group, pending, settings['notify_email'], log, on_goon=phone_only)
        finally:
            if intent:
                intent.close()
        if not emailed_by_goon:
            push(text, settings)
    finally:
        release(fd, marker)


def watch(payload):
    settings = read_settings()
    if missing := [n for n, v in settings.items() if not v]:  # fail now, not after sleeping until the reset
        log(f'missing plugin options: {", ".join(missing)}')
        return
    limit = lookup(payload.get('transcript_path'), LOOKUP_TRIES)
    if not limit:
        log(
            f'no limit message in transcript (error={payload.get("error")!r}, '
            f'details={str(payload.get("error_details"))[:120]!r})'
        )
        return
    now = datetime.now(timezone.utc)
    waitable = [cap for cap in limit.caps if cap.reset - now <= cap.max_wait]
    if not waitable:
        log(f'unusable reset time: {limit.caps[0].reset:%Y-%m-%d %H:%M}Z for the {limit.caps[0].label}')
        return
    for group in reset_groups(waitable):
        announce(group, limit.caps, settings)


def topic_text(rotate=False):
    """What `/portavoce topic` says: the topic pushes go to and how to subscribe the phone to it."""
    option = os.environ.get('CLAUDE_PLUGIN_OPTION_NTFY_TOPIC', '').strip()
    if option:
        note = 'The topic option is set, so that is the topic; clear the option to use a private one made here.'
        return f'Portavoce pushes to {option}. {note} {subscribe_steps(option, "/portavoce test")}'
    topic = stored_topic(DIR / 'topic', TOPIC_PREFIX, rotate=rotate)
    made = 'Made a new private topic, so drop the old one in the app. ' if rotate else ''
    return f'{made}Portavoce pushes to your private ntfy topic {topic}. {subscribe_steps(topic, "/portavoce test")}'


def send_test(settings):
    """Sends one push to the topic, without the email, and says whether it went through."""
    sent = ntfy_push(
        NTFY_URL,
        settings['ntfy_topic'],
        'Claude Portavoce test: if you can read this, the topic works.',
        log,
        title='Claude Portavoce test',
        tags='parrot,bell',
        icon=ICON_URL,
        token=settings['ntfy_token'],
    )
    return 'Sent: it should show up in the ntfy app now.' if sent else f'Not sent; {DIR / "log.txt"} says why.'


def main():
    DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if sys.argv[1:2] == ['topic']:
        print(topic_text(rotate=sys.argv[2:] == ['new']))
        return
    if sys.argv[1:] == ['test']:
        print(send_test(read_settings()))
        return
    if sys.argv[1:] == ['--watch']:
        try:
            watch(json.load(sys.stdin))
        except Exception:
            log(traceback.format_exc())
        return
    raw = sys.stdin.buffer.read()
    child = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), '--watch'],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    child.stdin.write(raw)
    child.stdin.close()


if __name__ == '__main__':
    main()
