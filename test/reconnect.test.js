/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Test client behaviour when server comes and goes.
 */

'use strict';

var bunyan = require('bunyan');
var mod_child = require('child_process');
var mod_stream = require('../lib/index');
var mod_uuid = require('uuid');
var test = require('tape');


// --- Globals

var CLIENT1;
var CLIENT2;

var CLIENT1_UUID = mod_uuid.v4();
var CLIENT2_UUID = mod_uuid.v4();

var SERVER;
var SERVER_NAME = mod_uuid.v4();
var PORT = 2222;
var MSGID = 1;

var LOG_LEVEL = process.env.LOG_LEVEL || 'fatal';
var LOG = bunyan.createLogger({
    name: 'fast-stream-test',
    src: true,
    streams: [ {
        stream: process.stderr,
        level: LOG_LEVEL
    } ]
});


// --- Internal helpers

function startServer() {
    SERVER = mod_child.fork('server.js', [ PORT, SERVER_NAME ], {
        cwd: __dirname
    });
}


// --- Setup

test('Setup', function (t) {
    CLIENT1 = mod_stream.createClient({
        client_id: CLIENT1_UUID,
        host: 'localhost',
        log: LOG.child({ component: 'client1' }),
        port: PORT
    });

    CLIENT2 = mod_stream.createClient({
        client_id: CLIENT2_UUID,
        host: 'localhost',
        log: LOG.child({ component: 'client2' }),
        port: PORT
    });

    t.end();
});


// --- Tests


test('Create clients, wait, and then create server', function (t) {
    t.plan(8);

    var done = 0;
    var serverStarted = false;

    var sendmsg = {
        id: MSGID++,
        req_id: mod_uuid.v4(),
        name: 'hello',
        value: {
            a: 1,
            b: 2,
            c: 3
        }
    };

    function onMsg(clNum, msg) {
        sendmsg.server_id = SERVER_NAME;
        t.deepEqual(msg, sendmsg, 'message is the same (' + clNum + ')');

        if (++done === 2) {
            t.end();
            return;
        }
    }

    CLIENT1.once('message', onMsg.bind(null, 1));
    CLIENT1.on('connect', function (cErr) {
        t.ifError(cErr, 'connect error');
        t.ok(serverStarted, 'server should be started');
        CLIENT1.on('start', function () {
            t.pass('CLIENT1 started');
        });
        CLIENT1.start();
    });
    CLIENT1.connect();

    CLIENT2.once('message', onMsg.bind(null, 2));
    CLIENT2.on('connect', function (cErr) {
        t.ifError(cErr, 'connect error');
        t.ok(serverStarted, 'server should be started');
        CLIENT2.on('start', function () {
            t.pass('CLIENT2 started');
        });
        CLIENT2.start();
    });
    CLIENT2.connect();

    setTimeout(function () {
        serverStarted = true;
        startServer();
        setTimeout(function () {
            SERVER.send(sendmsg);
        }, 2000);
    }, 3000);
});


function killAndRestart(signal) {
    return function (t) {
        var restarted1 = false;
        var restarted2 = false;
        var reconnected1 = false;
        var reconnected2 = false;
        var done = 0;

        var sendmsg = {
            id: MSGID++,
            req_id: mod_uuid.v4(),
            name: 'msg',
            value: {
                foo: 'bar'
            }
        };

        function finish() {
            if (++done === 2) {
                t.end();
            }
        }

        CLIENT1.once('message', function (msg) {
            sendmsg.server_id = SERVER_NAME;
            t.deepEqual(msg, sendmsg, 'message is the same');
            finish();
        });

        CLIENT1.on('stateChanged', function changed1(st) {
            if (st === 'restart') {
                restarted1 = true;
            } else if (st === 'connected') {
                reconnected1 = true;
            }
        });

        CLIENT2.once('message', function (msg) {
            sendmsg.server_id = SERVER_NAME;
            t.deepEqual(msg, sendmsg, 'message is the same');
            finish();
        });


        CLIENT2.on('stateChanged', function changed2(st) {
            if (st === 'restart') {
                restarted2 = true;
            } else if (st === 'connected') {
                reconnected2 = true;
            }
        });

        SERVER.on('exit', function () {
            t.pass('server exited');

            startServer();

            setTimeout(function () {
                t.ok(restarted1, 'CLIENT1 restarted');
                t.ok(restarted2, 'CLIENT2 restarted');
                t.ok(reconnected1, 'CLIENT1 reconnected');
                t.ok(reconnected2, 'CLIENT2 reconnected');
                SERVER.send(sendmsg);
            }, 1500);
        });
        SERVER.kill(signal);
    };
}

test('unexpected server restart causes clients to reconnect',
    killAndRestart('SIGKILL'));

test('graceful server restart causes clients to reconnect',
    killAndRestart('SIGTERM'));


// --- Teardown

test('Teardown', function (t) {
    if (CLIENT1) {
        CLIENT1.close();
    }

    if (CLIENT2) {
        CLIENT2.close();
    }

    if (SERVER) {
        SERVER.kill('SIGTERM');
    }

    t.end();
});
