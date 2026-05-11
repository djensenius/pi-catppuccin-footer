set shell := ["bash", "-cu"]

default:
	just --list

install:
	npm install

fmt:
	npm run format

lint:
	npm run lint

test:
	npm test

check:
	npm run check

pack:
	npm pack --dry-run

smoke:
	PI_OFFLINE=1 pi --no-extensions -e ./extensions/catppuccin-footer.ts --list-models definitely-no-such-model

ci:
	npm run ci
