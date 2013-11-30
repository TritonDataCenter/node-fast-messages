/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Stream client / server
 */

module.exports = {
    createClient: require('./client').createClient,
    createServer: require('./server').createServer
};
