<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# fast-stream

Stream event messages via node-fast.

# Repository

    lib/            Source files
    node_modules/   node.js dependencies (populate by running "npm install")
    tools/          Tools and configuration files
    test/           Test suite (using nodeunit)


# Development

Before checking in, please run:

    make check

and fix any warnings. Note that jsstyle will stop after the first file with an
error, so you may need to run this multiple times while fixing.


# Testing

    make test

To run an individual test:

    ./node_modules/.bin/nodeunit <path to test file>
