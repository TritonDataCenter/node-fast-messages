/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Stream client
 */

'use strict';

var assert = require('assert-plus');
var common = require('./common');
var mod_fast = require('fast');
var mod_mooremachine = require('mooremachine');
var mod_net = require('net');
var mod_util = require('util');

// --- Globals

var TCP_KEEPALIVE_DELAY = 10000;


// --- StreamClient object



function StreamClient(opts) {
    this.log = opts.log;
    delete opts.log;
    this.opts = opts;

    this.attempt = 0;

    this.client = null;
    this.socket = null;
    this.channel = null;

    this.emittedConnect = false;
    this.emittedStart = false;

    mod_mooremachine.FSM.call(this, 'stopped');
}
mod_util.inherits(StreamClient, mod_mooremachine.FSM);


StreamClient.prototype.state_stopped = function stopped(S) {
    S.validTransitions([ 'connecting' ]);

    S.on(this, 'connectAsserted', function () {
        S.gotoState('connecting');
    });
};


StreamClient.prototype.state_connecting = function connecting(S) {
    S.validTransitions([ 'connected', 'connecting.error', 'closing' ]);

    var self = this;

    self.attempt += 1;
    self.socket = mod_net.connect(self.opts.port, self.opts.host);

    S.on(self.socket, 'connect', function onConnect() {
        self.log.debug('fast: connected to %s after %d attempts',
            self.opts.host, self.attempt);
        S.gotoState('connected');
    });

    S.on(self.socket, 'error', function onConnectError(err) {
        self.connectError = err;
        S.gotoState('connecting.error');
    });

    S.on(this, 'closeAsserted', function onClose() {
        S.gotoState('closing');
    });
};


StreamClient.prototype.state_connecting.error = function connectingError(S) {
    S.validTransitions([ 'connecting' ]);

    var level, delay;
    if (this.attempt === 1) {
        level = 'info';
        delay = 0;
    } else if (this.attempt < 10) {
        level = 'warn';
        delay = 1000;
    } else {
        level = 'error';
        delay = 5000;
    }

    this.log[level]({
        err: this.connectErr,
        attempt: this.attempt,
        delay: delay
    }, 'connect attempted');

    S.timeout(delay, function () {
        S.gotoState('connecting');
    });
};


StreamClient.prototype._close = function closeInternal() {
    this.log.info('closing fast client and sockets');

    if (this.client !== null) {
        this.client.detach();
        this.client = null;
    }

    if (this.socket !== null) {
        this.socket.destroy();
        this.socket = null;
    }
};


StreamClient.prototype.state_closing = function closing(S) {
    S.validTransitions([ 'stopped' ]);

    var self = this;

    self._close();

    setImmediate(function () {
        self.emit('close');
    });

    S.gotoState('stopped');
};


StreamClient.prototype.state_restart = function restart(S) {
    S.validTransitions([ 'connecting' ]);
    this._close();
    this.attempt = 0;
    S.gotoState('connecting');
};


StreamClient.prototype.state_connected = function connected(S) {
    S.validTransitions([ 'started', 'closing' ]);

    var self = this;

    self.socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY);

    self.client = new mod_fast.FastClient({
        log: self.log,
        nRecentRequests: 100,
        transport: self.socket
    });

    /*
     * If we've already emitted "connect" before, then
     * this is a reconnect, and we can go straight to
     * state "started".
     */
    if (self.emittedConnect) {
        S.gotoState('started');
        return;
    }

    S.on(self, 'startAsserted', function () {
        S.gotoState('started');
    });

    S.on(self, 'closeAsserted', function () {
        S.gotoState('closing');
    });

    S.immediate(function () {
        self.emittedConnect = true;
        self.emit('connect');
    });
};


StreamClient.prototype.state_started = function starting(S) {
    S.validTransitions([ 'closing', 'restart', 'started.waiting' ]);

    var self = this;

    /*
     * node-fast expects us to handle transport errors. When we get an error,
     * restart the connection.
     */
    S.on(self.client, 'error', function (err) {
        self.log.error(err, 'restarting due to connection error');
        S.gotoState('restart');
    });

    self.channel = self.client.rpc({
        rpcmethod: 'messages',
        rpcargs: [ {
            client_id: self.opts.client_id,
            version: common.VERSION
        } ],
        log: self.log
    });

    S.on(self.channel, 'end', function () {
        self.log.info('messages rpc closed on other end; restarting');
        S.gotoState('restart');
    });

    /*
     * Log all errors, but otherwise ignore them. This will emit when:
     *
     *     - Request is abandoned (user closed stream)
     *     - Server connection dies (in which case we restart)
     */
    self.channel.on('error', function (err) {
        self.log.error(err, 'error from messages rpc');
    });

    S.on(self, 'closeAsserted', function () {
        self.channel.abandon();
        self.channel = null;
        S.gotoState('closing');
    });

    S.gotoState('started.waiting');
};


StreamClient.prototype.state_started.waiting = function waiting(S) {
    var self = this;

    S.on(self.channel, 'data', function waitForServerState(msg) {
        self.log.info({ state: msg }, 'server state sync complete');
        self.serverState = msg;

        S.gotoState('started.ready');
    });
};


StreamClient.prototype.state_started.ready = function read(S) {
    var self = this;

    if (!self.emittedStart) {
        self.emittedStart = true;
        setImmediate(function () {
            self.emit('start');
        });
    }

    S.on(self.channel, 'data', function onMessage(msg) {
        self.emit('message', msg);
    });
};


StreamClient.prototype.ping = function pingServer(callback) {
    var self = this;

    assert.ok(!self.isInState('stopped'), 'can only ping after starting');
    assert.func(callback, 'callback');

    if (self.client === null) {
        setImmediate(callback, new Error('stream not connected'));
        return;
    }

    var req = self.client.rpc({
        rpcmethod: 'ping',
        rpcargs: [ {} ],
        log: self.log
    });

    /*
     * We don't expect to receive any data, but we need to register
     * for the "data" event so that the stream doesn't remain paused
     * (and therefore never calls "end").
     */
    req.on('data', function (r) {
        self.log.debug({ data: r }, 'received ping data');
    });

    req.once('end', callback);
    req.once('error', callback);
};


StreamClient.prototype.start = function startStream() {
    assert.ok(this.isInState('connected'),
        'client must be connected before starting');
    this.log.info('starting stream');
    this.emit('startAsserted');
};


StreamClient.prototype.close = function close() {
    assert.ok(!this.isInState('stopped'), 'client already closed');
    this.emit('closeAsserted');
};


StreamClient.prototype.connect = function connect() {
    assert.ok(this.isInState('stopped'), 'client already started');
    this.emit('connectAsserted');
};



// --- Exports

function createClient(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.host, 'opts.host');
    assert.object(opts.log, 'opts.log');
    assert.number(opts.port, 'opts.port');
    assert.string(opts.client_id, 'opts.client_id');

    opts.log = opts.log.child({ component: 'stream-client' });
    return new StreamClient(opts);
}


module.exports = {
    createClient: createClient
};
