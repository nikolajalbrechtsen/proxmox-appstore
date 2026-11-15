'use strict';
// Proxmox gives a container its network address only after the app in it has started. An app that needs the
// network in its first seconds (to download something, for example) finds none, gives up and the container stops.
// So the start command is wrapped: wait until the network has a default route, at most 60 seconds, then start
// the app as usual. Used by the store's installer and by tools/compat.js.
//
// The wrapper is a small shell script followed by the image's own start command, exactly as Proxmox wrote it.
// The script runs that command as its arguments ("$@"), so nothing in the command has to be quoted again, and a
// command without a path ("node server.js") is found the same way as in Docker.
const WAIT = 'i=0; while [ $i -lt 60 ]; do while read -r a b c; do [ x$b = x00000000 ] && break 2; done </proc/net/route; i=$((i+1)); sleep 1; done;';
const PREFIX = "/bin/sh -c '";

// Every start command can be wrapped, as long as the image has /bin/sh. Whether it has one only shows when the
// container is started, so callers fall back to the image's own command when the wrapped one does not start.
const wrappable = entrypoint => typeof entrypoint === 'string' && entrypoint.trim() !== '' && !entrypoint.startsWith(PREFIX);
const waitNet = entrypoint => `${PREFIX}${WAIT} exec "$@"' sh ${entrypoint}`;
// For finding out why an app stops: the same wait, then the app with its output saved to a file, and two minutes
// in which the container stays alive so the file can be read.
const LOG = '/appstore-start.log';
const capture = entrypoint => `${PREFIX}${WAIT} "$@" >${LOG} 2>&1; echo The app ended with exit code $? >>${LOG}; sleep 120' sh ${entrypoint}`;
// The useful part of that output: the lines that name a problem, or else the last ones.
function summary(out) {
  const lines = String(out).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n');
  // Some apps insist on being the first process in the container, which they are not while their output is captured.
  if (lines.some(l => /can only run as pid 1/i.test(l))) return null;
  const cause = lines.filter(l => /error|fail|fatal|denied|unreachable|cannot|could not|not found|no such|exit code/i.test(l) && !/^\s+at /.test(l));
  return (cause.length > 12 ? cause.slice(-12) : cause.length > 1 ? cause : lines.slice(-12)).join('\n').slice(-2500) || null;
}

module.exports = { wrappable, waitNet, capture, summary, LOG };
