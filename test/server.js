/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Run a fast-stream server in its own child process.
 */

'use strict';

var assert = require('assert-plus');
var bunyan = require('bunyan');
var mod_stream = require('../lib/index');

var SERVER = null;

function disconnect() {
    if (SERVER !== null) {
        SERVER.close(function () {
            process.exit(0);
        });
        SERVER = null;
    }
}

process.on('disconnect', disconnect);
process.on('SIGTERM', disconnect);

assert.string(process.argv[2], 'port provided');
assert.string(process.argv[3], 'name provided');

var LOG_LEVEL = process.env.LOG_LEVEL || 'fatal';
var LOG = bunyan.createLogger({
    name: 'fast-stream-test',
    src: true,
    streams: [ {
        stream: process.stderr,
        level: LOG_LEVEL
    } ]
});

SERVER = mod_stream.createServer({
    log: LOG.child({ component: 'server' }),
    server_id: process.argv[3]
});

SERVER.listen(parseInt(process.argv[2], 10), function (lErr) {
    if (lErr) {
        throw lErr;
    }

    console.log('server started');
});

process.on('message', function (message) {
    if (SERVER !== null) {
        SERVER.send(message);
    }
});
