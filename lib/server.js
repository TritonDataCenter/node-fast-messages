/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Stream server: streams events to clients using node-fast
 */

'use strict';

var assert = require('assert-plus');
var common = require('./common');
var mod_fast = require('fast');
var mod_net = require('net');
var mod_uuid = require('uuid');


// --- Internal helpers

function isObject(obj) {
    return (typeof (obj) === 'object') && obj !== null && !Array.isArray(obj);
}


// --- Endpoints

function messagesHandler(server) {
    function _messagesHandler(rpc) {
        var argv = rpc.argv();
        if (argv.length !== 1) {
            rpc.fail(new Error('"messages" RPC expects one argument'));
            return;
        }

        var opts = argv[0];

        if (!isObject(opts)) {
            server.log.info({ opts: opts }, 'unidentified client connected');
            rpc.fail(new Error('"messages" RPC expects an options object'));
            return;
        }

        if (typeof (opts.client_id) !== 'string') {
            server.log.info({ opts: opts }, 'unidentified client connected');
            rpc.fail(new Error('clients must provide their "client_id"'));
            return;
        }

        server.addClient(opts, rpc);
    }

    return _messagesHandler;
}


function pingHandler(server) {
    function _pingHandler(rpc) {
        var argv = rpc.argv();
        if (argv.length !== 1) {
            rpc.fail(new Error('"ping" RPC expects one argument'));
            return;
        }

        var opts = argv[0];

        if (!isObject(opts)) {
            server.log.info({ opts: opts }, 'client sent bad ping payload');
            rpc.fail(new Error('"ping" RPC expects an options object'));
            return;
        }

        if (opts.req_id && typeof (opts.req_id) !== 'string') {
            rpc.fail(new Error('"req_id" must be a string if provided'));
            return;
        }

        var log = server.log.child({
            req_id: opts.req_id || mod_uuid.v1()
        });

        log.info(opts, 'server received ping');
        rpc.end();
    }

    return _pingHandler;
}


// --- StreamServer object


/**
 * StreamServer constructor
 *
 * @param opts {Object} : with the following required properties:
 *     - log {Object} : Bunyan logger
 *     - server_id {Object} : UUID of this host
 */
function StreamServer(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.server_id, 'opts.server_id');
    assert.object(opts.log, 'opts.log');

    self.log = opts.log.child({ component: 'stream' });
    self.clients = {};
    self.state = {
        clients: [],
        server_id: opts.server_id
    };
    self.port = null;

    // Set up socket and listen for when it's ready
    self.fast_socket = mod_net.createServer({ allowHalfOpen: false });

    self.fast_socket.on('listening', function () {
        self.log.info({ address: self.fast_socket.address() },
            'fast server listening on port %d', self.port);
    });

    // Set up Fast server and its endpoints
    self.fast_server = new mod_fast.FastServer({
        log: opts.log.child({ component: 'fast' }),
        server: self.fast_socket
    });

    self.fast_server.registerRpcMethod({
        rpcmethod: 'messages',
        rpchandler: messagesHandler(self)
    });

    self.fast_server.registerRpcMethod({
        rpcmethod: 'ping',
        rpchandler: pingHandler(self)
    });

    self.log.info({ maxConnections: self.fast_socket.maxConnections },
        'fast server created');
}


Object.defineProperty(StreamServer.prototype, 'id', {
    get: function () { return this.state.server_id; }
});


/**
 * Save a new connected client, and reply to it to inform it that it can start
 * receiving messages.
 */
StreamServer.prototype.addClient = function addClient(opts, rpc) {
    assert.object(rpc, 'rpc');
    assert.object(opts, 'opts');
    assert.string(opts.client_id, 'opts.client_id');

    var clientID = opts.client_id;
    var self = this;

    // If we still have an RPC handle for this client, remove it first.
    if (self.state.clients.indexOf(clientID) !== -1) {
        self.log.warn('duplicate client "%s" connected', clientID);
        self.removeClient(clientID);
    }

    self.state.clients.push(clientID);
    self.clients[clientID] = rpc;

    // Send the current server state to the client
    if (opts.hasOwnProperty('version') && opts.version >= 1) {
        var curState = {
            name: 'sync',
            last_req_id: self.state.last_req_id,
            last_id: self.state.last_id,
            server_id: self.state.server_id,
            version: common.VERSION
        };

        self.log.info({ state: curState },
            'client %s: sending current state', clientID);

        rpc.write(curState);
    }

    self.log.info('client "%s" added', clientID);
};


/**
 * Remove a client's RPC handle and end it so that it gets cleaned up.
 */
StreamServer.prototype.removeClient = function removeClient(clientID) {
    if (this.clients.hasOwnProperty(clientID)) {
        this.clients[clientID].end();
        delete this.clients[clientID];
    }

    var idx = this.state.clients.indexOf(clientID);
    if (idx !== -1) {
        this.state.clients.splice(idx, 1);
    }
};


/**
 * Closes the fast server
 */
StreamServer.prototype.close = function close(callback) {
    assert.optionalFunc(callback, 'callback');

    var self = this;

    self.log.info('shutting down server');

    for (var conn in self.clients) {
        self.clients[conn].end();
    }

    self.fast_socket.on('close', function () {
        self.fast_server.close();

        if (typeof (callback) !== 'function') {
            return;
        }

        callback();
    });
    self.fast_socket.close();
};


/**
 * Listens on the given port
 *
 * @param port {Number} : Port number to listen on
 * @param callback {Function} `function (err)`
 */
StreamServer.prototype.listen = function listen(port, callback) {
    assert.number(port, 'port');
    assert.func(callback, 'callback');

    this.port = port;
    this.fast_socket.listen(port, callback);
};


/**
 * Sends an event to all connected clients
 *
 * @param opts {Object} : with the following properties:
 *     - id {Number} : Sequence number of this update (Optional)
 *     - name {String} : Name of the update
 *     - value {Any} : Update data to send
 *     - req_id {UUID} : Request UUID (Optional)
 */
StreamServer.prototype.send = function send(opts) {
    assert.object(opts, 'opts');
    assert.ok(opts.value !== undefined, 'opts.value');
    assert.string(opts.name, 'opts.name');
    assert.optionalNumber(opts.id, 'opts.id');
    assert.optionalString(opts.req_id, 'opts.req_id');

    var req_id = opts.req_id || mod_uuid.v1();
    var message = {
        id: opts.id,
        name: opts.name,
        req_id: req_id,
        server_id: this.state.server_id,
        value: opts.value
    };

    this.log.debug({
        req_id: req_id,
        message: message
    }, 'sending message to clients');

    for (var conn in this.clients) {
        var client = this.clients[conn];
        this.log.trace({ req_id: req_id },
            'sending message to client "%s"', conn);
        client.write(message);
    }

    this.state.last_req_id = req_id;
    if (opts.id) {
        this.state.last_id = opts.id;
    }
};



// --- Exports



/**
 * Creates a new stream server
 *
 * @param opts {Object} : As required by the StreamServer constructor
 */
function createServer(opts) {
    return new StreamServer(opts);
}



module.exports = {
    createServer: createServer
};
