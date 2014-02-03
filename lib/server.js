/*
 * Copyright (c) 2014 Joyent, Inc.  All rights reserved.
 *
 * Stream server: streams events to clients using node-fast
 */

var assert = require('assert-plus');
var common = require('./common');
var fast = require('fast');
var util = require('util');
var uuid = require('node-uuid');



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

    this.clients = {};
    this.log = opts.log.child({ component: 'stream' });
    this.server = fast.createServer({ log: this.log });
    this.state = {
        clients: [],
        server_id: opts.server_id
    };

    this.__defineGetter__('id', function () {
        return this.state.server_id;
    });

    this.server.on('error', function onError(err) {
        self.log.error(err, 'fast server error');
    });

    this.server.on('clientError', function onClientError(err) {
        self.log.error(err, 'fast client error');
    });

    this.server.on('uncaughtException', function (err) {
        self.log.error(err, 'fast server uncaught exception');
    });

    this.server.on('connection', function onConnect(sock) {
        self.log.info('connected: ' + sock.remoteAddress);
    });

    this.registerHandlers();
    this.log.info({ maxConnections: this.server.maxConnections },
        'fast server created');
}


/**
 * Closes the fast server
 */
StreamServer.prototype.close = function close(port, callback) {
    this.server.close();
};


/**
 * Listens on the given port
 *
 * @param port {Number} : Port number to listen on
 * @param callback {Function} `function (err)`
 */
StreamServer.prototype.listen = function listen(port, callback) {
    assert.number(port, 'port');
    this.port = port;

    return this.server.listen(port, callback);
};


/**
 * Registers fast handlers for ping and updates
 */
StreamServer.prototype.registerHandlers = function register() {
    var self = this;

    function messagesHandler(opts, res) {
        var clientID = opts.client_id;
        if (!clientID) {
            clientID = uuid.v4();
            self.log.info('unidentified client "%s" added', clientID);
        } else {
            self.log.info('client "%s" added', clientID);
        }

        function _end(ev, err) {
            var str = util.format('client %s: connection ended', clientID);
            if (err) {
                self.log.error(err, str);

            } else {
                self.log.info(str);
            }

            delete self.clients[clientID];
            self.state.clients.splice(self.state.clients.indexOf(clientID), 1);
        }

        res.connection.on('end', _end.bind(null, 'end'));
        res.connection.on('error', _end.bind(null, 'error'));
        res.connection.on('close', _end.bind(null, 'close'));

        if (self.state.clients.indexOf(clientID) === -1) {
            self.state.clients.push(clientID);
        } else {
            // XXX: log IP / port for the old client
            self.log.warn('duplicate client "%s" connected', clientID);
        }

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
            res.write(curState);
        }
        self.clients[clientID] = res;
    }

    function pingHandler(opts, res) {
        var log = self.log.child({
            component: 'fast',
            req_id: opts.req_id || uuid.v1()
        });

        log.info(opts, 'ping');
        res.end();
    }

    this.server.rpc('messages', messagesHandler);
    this.server.rpc('ping', pingHandler);
};


/**
 * Sends an event to all connected clients
 *
 * @param opts {Object} : with the following properties:
 *     - id {Number} : Sequence number of this update (Optional)
 *     - name {String} : Name of the update
 *     - value {Object} : Update data to send
 *     - req_id {UUID} : Request UUID (Optional)
 */
StreamServer.prototype.send = function send(opts) {
    var message = {
        id: opts.id,
        name: opts.name,
        req_id: opts.req_id || uuid.v1(),
        server_id: this.state.server_id,
        value: opts.value
    };

    // XXX: want a way of changing this (other than log level?)
    this.log.debug({ message : message }, 'sending message');

    for (var conn in this.clients) {
        var client = this.clients[conn];
        this.log.trace({ id: message.id, client: conn, req_id: message.req_id },
                'sending client message');
        client.write(message);
    }

    this.state.last_req_id = opts.req_id;
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
