#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

#
# fast-messages Makefile
#

#
# Tools
#

ISTANBUL	:= node_modules/.bin/istanbul
FAUCET		:= node_modules/.bin/faucet
NODE		:= node
NPM		:= npm

#
# Files
#

JS_FILES	:= $(shell find lib test -name '*.js')
JSSTYLE_FILES	= $(JS_FILES)
JSSTYLE_FLAGS	= -f tools/jsstyle.conf
ESLINT_FILES	= $(JS_FILES)

include ./tools/mk/Makefile.defs

#
# Repo-specific targets
#

.PHONY: all
all:
	$(NPM) install

$(ISTANBUL):
	$(NPM) install

$(FAUCET):
	$(NPM) install

CLEAN_FILES += ./node_modules/

#
# test / check targets
#

.PHONY: test
test: $(ISTANBUL) $(FAUCET)
	@$(NODE) $(ISTANBUL) cover --print none test/run.js | $(FAUCET)

include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
