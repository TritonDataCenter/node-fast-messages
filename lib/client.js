/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Stream client
 */

var assert = require('assert-plus');
var backoff = require('backoff');
var common = require('./common');
var EventEmitter = require('events').EventEmitter;
var fast = require('fast');
var once = require('once');
var util = require('util');



// --- StreamClient object



function StreamClient(opts) {
    this.log = opts.log;
    delete opts.log;
    this.opts = opts;
    this.streaming = false;

    EventEmitter.call(this);
}

util.inherits(StreamClient, EventEmitter);


StreamClient.prototype.ping = function pingServer(callback) {
    var req = this.client.rpc('ping', {});
    req.once('end', callback);
    req.once('error', callback);
};


StreamClient.prototype.start = function startStream(callback) {
    var self = this;
    var req = this.client.rpc('messages', {
        client_id: this.opts.client_id,
        version: common.VERSION
    });
    self.streaming = true;
    self.serverSync = false;

    function done(err) {
        if (err) {
            self.log.error(err, 'error from messages rpc');
        } else {
            self.log.info('messages rpc closed on other end');
        }

        self.client.removeAllListeners('message');
        if (!self.serverSync) {
            // XXX: need to remove end / error listeners here?
            return callback(err);
        }
    }

    req.once('end', done);
    req.once('error', done);

    function waitForServerState(msg) {
        req.removeListener('message', waitForServerState);
        req.on('message', onMessage);

        self.log.info(msg, 'server state sync complete');
        self.serverSync = true;
        return callback();
    }

    function onMessage(msg) {
        self.emit('message', msg);
    }

    req.on('message', waitForServerState);
};


StreamClient.prototype.restart = function restartStream() {
    // XXX: if sequence numbers differ, do a sync.
    this.start();
};


StreamClient.prototype.close = function close(callback) {
    if (!this.client) {
        return;
    }

    this.client.close();
};


StreamClient.prototype.connect = function connect(callback) {
    var connOpts = { host: this.opts.host, port: this.opts.port };
    var log = this.log;
    var self = this;
    callback = once(callback);

    retryConnect(this.opts, log, function connect_cb(connectErr, client) {
        if (connectErr) {
            log.error(connectErr, 'fast client: connection error');
            return callback(connectErr);
        }

        client.log = log;

        // node-fast has reconnect logic, so just capture that events
        // happened, and let it handle
        client.on('error', function (err) {
            if (!client._deadbeef) {
                log.error(err, 'client error');
            }
        });

        client.on('close', function () {
            if (!client._deadbeef) {
                log.warn(connOpts, 'connection closed');
            }
        });

        client.on('connect', function () {
            if (!client._deadbeef) {
                log.info(connOpts, 'connected');
                if (self.streaming) {
                    self.restart();
                }
            }
        });

        self.client = client;
        return callback();
    });
};



// --- Internals



function retryConnect(opts, log, callback) {
    assert.object(opts, 'options');
    assert.func(callback, 'callback');

    callback = once(callback);

    function _connect(_, cb) {
        cb = once(cb);
        var client = fast.createClient(opts);

        client.on('connectAttempt', function (number, delay) {
            var level;
            if (number === 0) {
                level = 'info';
            } else if (number < 5) {
                level = 'warn';
            } else {
                level = 'error';
            }

            log[level]({ host: opts.host, attempt: number, delay: delay },
                'connect attempted');
        });

        client.once('connect', function onConnect() {
            client.removeAllListeners('error');
            cb(null, client);
        });

        client.once('error', function onConnectError(err) {
            client.removeAllListeners('connect');
            cb(err);
        });
    }

    var retry = backoff.call(_connect, {}, function (err, client) {
        retry.removeAllListeners('backoff');
        log.debug('fast: connected to %s after %d attempts',
            opts.host, retry.getResults().length);
        callback(err, client);
    });

    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: opts.minTimeout || 100,
        maxDelay: opts.maxTimeout || 60000
    }));
    retry.failAfter(opts.retries || Infinity);

    retry.on('backoff', function onBackoff(number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }

        log[level]({
            attempt: number,
            delay: delay
        }, 'connect attempted');
    });

    retry.start();
}



// --- Exports



function createClient(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.host, 'opts.host');
    assert.object(opts.log, 'opts.log');
    assert.number(opts.port, 'opts.port');
    assert.string(opts.client_id, 'opts.client_id');

    opts.log = opts.log.child({ component: 'stream_client' });
    return new StreamClient(opts);
}



module.exports = {
    createClient: createClient
};
