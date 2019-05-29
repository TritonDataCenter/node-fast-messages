/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Basic client / server test
 */

'use strict';

var bunyan = require('bunyan');
var mod_fast = require('fast');
var mod_net = require('net');
var mod_stream = require('../lib/index');
var mod_uuid = require('uuid');
var test = require('tape');
var vasync = require('vasync');


// --- Globals

var CLIENT1;
var CLIENT2;

var CLIENT1_UUID = mod_uuid.v4();
var CLIENT2_UUID = mod_uuid.v4();

var SERVER;
var HOST = 'localhost';
var PORT = 3333;
var TIMEOUT = 5000;
var INVALID_PORT = 9999;

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

/**
 * Make a Fast RPC to the streaming server.
 *
 * Normally the StreamClient would be used to connect and receive messages,
 * but this function allows for testing some server checks that are normally
 * not exercised by well-behaved clients.
 */
function makeFastRequest(opts, cb) {
    var socket = mod_net.connect(PORT, HOST);

    socket.on('error', cb);

    socket.on('connect', function () {
        socket.removeListener('error', cb);

        var client = new mod_fast.FastClient({
            log: opts.log,
            nRecentRequests: 100,
            transport: socket
        });

        client.rpcBufferAndCallback(opts.call, function (err, data, ndata) {
            client.detach();
            socket.destroy();
            cb(err, data, ndata);
        });
    });
}


function checkFastRequestFails(t, endpoint, args, errmsg) {
    makeFastRequest({
        log: LOG,
        call: {
            rpcmethod: endpoint,
            rpcargs: args,
            maxObjectsToBuffer: 100
        }
    }, function (err, data, ndata) {
        t.ok(err, 'should return error');
        t.deepEqual(data, [], 'no data returned (data=[])');
        t.deepEqual(ndata, 0, 'no data returned (ndata=0)');

        if (err) {
            t.deepEqual(err.message,
                'request failed: server error: ' + errmsg,
                'correct error message: ' + errmsg);
        }

        t.end();
    });
}



// --- Tests

/*
 * Create a server and a couple of clients.
 */
test('Setup', function (t) {
    SERVER = mod_stream.createServer({
        log: LOG.child({ component: 'server' }),
        server_id: mod_uuid.v4()
    });

    CLIENT1 = mod_stream.createClient({
        client_id: CLIENT1_UUID,
        host: HOST,
        log: LOG.child({ component: 'client1' }),
        port: PORT
    });

    CLIENT2 = mod_stream.createClient({
        client_id: CLIENT2_UUID,
        host: HOST,
        log: LOG.child({ component: 'client2' }),
        port: PORT
    });

    vasync.pipeline({ funcs: [
        function (_, cb) {
            SERVER.listen(PORT, function (sErr) {
                t.ifError(sErr, 'listen error');
                cb(sErr);
            });
        }, function (_, cb) {
            CLIENT1.on('connect', function (cErr) {
                t.ifError(cErr, 'connect error');
                cb(cErr);
            });

            CLIENT1.connect();
        }, function (_, cb) {
            CLIENT1.on('start', function (stErr) {
                t.ifError(stErr, 'start error');
                cb(stErr);
            });

            CLIENT1.start();
        }, function (_, cb) {
            CLIENT2.on('connect', function (cErr) {
                t.ifError(cErr, 'connect error');
                cb(cErr);
            });

            CLIENT2.connect();
        }, function (_, cb) {
            CLIENT2.on('start', function (stErr) {
                t.ifError(stErr, 'start error');
                cb(stErr);
            });

            CLIENT2.start();
        }
    ] }, function () {
        t.end();
    });
});


/*
 * Send a message from the server, and check that both clients receive it.
 */
test('send / receive', function (t) {
    var msg = {
        id: 4,
        req_id: mod_uuid.v4(),
        name: 'update_name',
        value: 'foo'
    };
    var num = 0;

    var tid = setTimeout(function _timedOut() {
        t.fail('Did not receieve message in time');
        t.deepEqual(SERVER.state, {}, 'server state');
        t.end();
    }, TIMEOUT);

    function eqMsg(clNum, recvMsg) {
        num++;
        if (tid && num === 2) {
            clearTimeout(tid);
        }

        msg.server_id = SERVER.id;
        t.deepEqual(recvMsg, msg, 'message is the same (' + clNum + ')');

        if (num === 2) {
            t.end();
            return;
        }
    }

    CLIENT1.once('message', eqMsg.bind(null, 1));
    CLIENT2.once('message', eqMsg.bind(null, 2));

    SERVER.send(msg);
});


test('ping', function (t) {
    t.test('CLIENT1 ping', function (t2) {
        CLIENT1.ping(function (err) {
            t2.ifError(err, 'ping error');
            t2.end();
        });
    });

    t.test('CLIENT2 ping', function (t2) {
        CLIENT2.ping(function (err) {
            t2.ifError(err, 'ping error');
            t2.end();
        });
    });
});


test('ping when not connected', function (t) {
    var client = mod_stream.createClient({
        client_id: mod_uuid.v4(),
        host: HOST,
        log: LOG.child({ component: 'client1' }),
        port: INVALID_PORT
    });

    client.on('connect', function () {
        t.fail('client should not connect');
    });

    client.on('close', function () {
        t.end();
    });

    setImmediate(function () {
        client.ping(function (err) {
            t.ok(err);
            if (err) {
                t.deepEqual(err.message, 'stream not connected');
            }
            client.close();
        });
    });

    client.connect();
});


test('connect and then close', function (t) {
    var client = mod_stream.createClient({
        client_id: mod_uuid.v4(),
        host: HOST,
        log: LOG.child({ component: 'client1' }),
        port: PORT
    });

    client.on('connect', function () {
        client.close();
    });

    client.on('close', function () {
        t.end();
    });

    client.connect();
});


test('new client replaces old one', function (t) {
    var sendmsg = {
        id: 5,
        req_id: mod_uuid.v4(),
        name: 'informational',
        value: {
            a: 5,
            b: '12'
        }
    };

    CLIENT1.on('close', function () {
        CLIENT1 = mod_stream.createClient({
            client_id: CLIENT1_UUID,
            host: HOST,
            log: LOG.child({ component: 'client1' }),
            port: PORT
        });

        CLIENT1.once('message', function (msg) {
            sendmsg.server_id = SERVER.id;
            t.deepEqual(msg, sendmsg, 'message is the same');
            t.end();
        });

        CLIENT1.on('connect', function (cErr) {
            t.ifError(cErr, 'connect error');
            CLIENT1.on('start', function (sErr) {
                t.ifError(sErr, 'start error');
                setImmediate(function () {
                    SERVER.send(sendmsg);
                });
            });
            CLIENT1.start();
        });

        CLIENT1.connect();
    });

    CLIENT1.close();
});


test('attempt connecting to bad address and then close', function (t) {
    var client = mod_stream.createClient({
        client_id: mod_uuid.v4(),
        host: HOST,
        log: LOG.child({ component: 'client1' }),
        port: INVALID_PORT
    });

    client.on('connect', function () {
        t.fail('client should not connect');
    });

    client.on('close', function () {
        t.end();
    });

    setTimeout(function () {
        t.ok(client.isInState('connecting'), 'in state "connecting"');
        client.close();
    }, 1000);

    client.connect();
});


test('bad "messages" RPC arguments', function (t) {
    t.test('too few arguments', function (t2) {
        checkFastRequestFails(t2, 'messages', [ ],
            '"messages" RPC expects one argument');
    });

    t.test('too many arguments', function (t2) {
        checkFastRequestFails(t2, 'messages', [ {}, {} ],
            '"messages" RPC expects one argument');
    });

    t.test('non-object argument', function (t2) {
        checkFastRequestFails(t2, 'messages', [ 'hello' ],
            '"messages" RPC expects an options object');
    });

    t.test('non-string "client_id"', function (t2) {
        checkFastRequestFails(t2, 'messages', [ { client_id: 5 } ],
            'clients must provide their "client_id"');
    });
});


test('bad "ping" RPC arguments', function (t) {
    t.test('too few arguments', function (t2) {
        checkFastRequestFails(t2, 'ping', [ ],
            '"ping" RPC expects one argument');
    });

    t.test('too many arguments', function (t2) {
        checkFastRequestFails(t2, 'ping', [ {}, {} ],
            '"ping" RPC expects one argument');
    });

    t.test('non-object argument', function (t2) {
        checkFastRequestFails(t2, 'ping', [ 'hello' ],
            '"ping" RPC expects an options object');
    });

    t.test('non-string "req_id"', function (t2) {
        checkFastRequestFails(t2, 'ping', [ { req_id: 5 } ],
            '"req_id" must be a string if provided');
    });
});


// --- Teardown

test('Teardown', function (t) {
    if (CLIENT1) {
        CLIENT1.close();
    }

    if (CLIENT2) {
        CLIENT2.close();
    }

    if (SERVER) {
        SERVER.close();
    }

    t.end();
});
