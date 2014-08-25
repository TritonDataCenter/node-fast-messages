/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Basic client / server test
 */

var bunyan = require('bunyan');
var mod_stream = require('../lib/index');
var mod_uuid = require('node-uuid');
var vasync = require('vasync');



var CLIENT1;
var CLIENT2;
var LOG_LEVEL = 'fatal';
var SERVER;
var TIMEOUT = 5000;



/*
 * Create a server and a couple of clients.
 */
exports['Initial setup'] = function (t) {
    var log = bunyan.createLogger({
        name: 'fast-stream-test',
        level: LOG_LEVEL
    });
    var port = 3333;

    SERVER = mod_stream.createServer({
        log: log.child({ component: 'server' }),
        server_id: mod_uuid.v4()
    });
    CLIENT1 = mod_stream.createClient({
        client_id: mod_uuid.v4(),
        host: 'localhost',
        log: log.child({ component: 'client1' }),
        port: port
    });

    CLIENT2 = mod_stream.createClient({
        client_id: mod_uuid.v4(),
        host: 'localhost',
        log: log.child({ component: 'client2' }),
        port: port
    });

    vasync.pipeline({ funcs: [
        function (_, cb) {
            SERVER.listen(port, function (sErr) {
                t.ifError(sErr, 'listen error');
                return cb(sErr);
            });

        // -- Client 1

        }, function (_, cb) {
            CLIENT1.connect(function (cErr) {
                t.ifError(cErr, 'connect error');
                return cb(cErr);
            });

        }, function (_, cb) {
            CLIENT1.start(function (stErr) {
                t.ifError(stErr, 'start error');
                return cb(stErr);
            });

        // -- Client 2

        }, function (_, cb) {
            CLIENT2.connect(function (cErr) {
                t.ifError(cErr, 'connect error');
                return cb(cErr);
            });

        }, function (_, cb) {
            CLIENT2.start(function (stErr) {
                t.ifError(stErr, 'start error');
                return cb(stErr);
            });
        }
    ] }, function () {
        return t.done();
    });
};


/*
 * Send a message from the server, and check that both clients receive it.
 */
exports['send / receive'] = function (t) {
    var msg = {
        id: 4,
        req_id: mod_uuid.v4(),
        name: 'update_name',
        value: 'foo'
    };
    var num = 0;

    var tid = setTimeout(function _timedOut() {
        t.ok(false, 'Did not receieve message in time');
        t.deepEqual(SERVER.state, {}, 'server state');

        return t.done();
    }, TIMEOUT);

    function eqMsg(clNum, recvMsg) {
        num++;
        if (tid && num === 2) {
            clearTimeout(tid);
        }

        msg.server_id = SERVER.id;
        t.deepEqual(recvMsg, msg, 'message is the same (' + clNum + ')');

        if (num === 2) {
            return t.done();
        }
    }

    CLIENT1.on('message', eqMsg.bind(null, 1));
    CLIENT2.on('message', eqMsg.bind(null, 2));

    SERVER.send(msg);
};


exports['Teardown'] = function (t) {
    if (CLIENT1) {
        CLIENT1.close();
    }

    if (CLIENT2) {
        CLIENT2.close();
    }

    if (SERVER) {
        SERVER.close();
    }
};
