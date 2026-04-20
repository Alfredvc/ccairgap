# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.4.0](https://github.com/Alfredvc/ccairgap/compare/v0.3.0...v0.4.0) (2026-04-20)


### Features

* add ccairgap-dir mount kind and /ccairgap-dir reserved path ([f834331](https://github.com/Alfredvc/ccairgap/commit/f834331f33c41b12153dc83f10f45f901d90ba45))
* add resolveCcairgapDir() to detect .ccairgap/ at workspace repo root ([c479f18](https://github.com/Alfredvc/ccairgap/commit/c479f18296e89f62e743ade17683813ae9e79c83))
* **autoMemory:** resolve effective host auto-memory dir via Claude Code settings cascade ([4e7ccee](https://github.com/Alfredvc/ccairgap/commit/4e7ccee5e115305dd0030abd83a85b01c0ec097d))
* **cli:** add --no-auto-memory flag + config key ([7b4aed2](https://github.com/Alfredvc/ccairgap/commit/7b4aed2564eeb97ef4ae38f41d1c9b18b4b9c0cf))
* **e2e:** add E2E test harness infrastructure ([7acb4ad](https://github.com/Alfredvc/ccairgap/commit/7acb4ad014d8777f7d8063828d5dd08d65bb6316))
* forward claude args via `--` tail and config ([c38b581](https://github.com/Alfredvc/ccairgap/commit/c38b581134ffef0112ad8bb7c8309e6faac6ce51))
* inject .ccairgap/ scope CLAUDE.md, settings.json, mcp.json, skills/ in entrypoint ([42201df](https://github.com/Alfredvc/ccairgap/commit/42201df38d68bff8e34f80b9c847b02f2e67e0f7))
* **mounts:** forward NODE_EXTRA_CA_CERTS into the container ([0e4aa00](https://github.com/Alfredvc/ccairgap/commit/0e4aa009fad437a8ade66f057f26354eeef61c07))
* **mounts:** surface auto-memory dir RO via CLAUDE_COWORK_MEMORY_PATH_OVERRIDE ([0c9dab2](https://github.com/Alfredvc/ccairgap/commit/0c9dab29b9dab9768e4f6c63dc15feb494364475))
* **mounts:** surface managed-policy dir RO at /etc/claude-code ([f54515b](https://github.com/Alfredvc/ccairgap/commit/f54515b1dd519db15841b1ceab6c85a49e145c16))
* overlay host working-tree project .claude config into sandbox ([97f7f38](https://github.com/Alfredvc/ccairgap/commit/97f7f3870d1cdc61a6d2ca286084507b7b5089d6))
* **paths:** honor CLAUDE_CONFIG_DIR for host config home resolution ([880759f](https://github.com/Alfredvc/ccairgap/commit/880759f84bca0932cf401ea2a1e365832a7c7562))
* pre-launch auth refresh + stripped refresh token ([87eca77](https://github.com/Alfredvc/ccairgap/commit/87eca774926dbf8b1e2063977cbf1dd68b069e56))
* wire ccairgapDir into buildMounts, anchored on workspace repo root ([dbdd32d](https://github.com/Alfredvc/ccairgap/commit/dbdd32de60a9edefa21c4ef2eb5e1ed30b3d77f7))


### Bug Fixes

* close reviewer nits from mount-missing-claude-state review ([421cd94](https://github.com/Alfredvc/ccairgap/commit/421cd94a81035d06e927c601ca4f0b1a39bf8f3d))
* **e2e:** make tier1/tier2 suites pass on macOS ([1c81b64](https://github.com/Alfredvc/ccairgap/commit/1c81b64e26e409d80b7dc7fa13c374cd8c62e5c7))


### Refactors

* drop redundant resume-hint printout on exit ([b41ae4e](https://github.com/Alfredvc/ccairgap/commit/b41ae4e50c72f1486acbb14f1b209e8b8363929d))

## [0.3.0](https://github.com/Alfredvc/ccairgap/compare/v0.2.0...v0.3.0) (2026-04-19)


### Features

* **cli:** add --no-clipboard flag and config key ([8929b47](https://github.com/Alfredvc/ccairgap/commit/8929b478cda4bd03cd8ca37ee04450984bee9bd4))
* **cli:** add --no-preserve-dirty opt-out flag ([b9e62f7](https://github.com/Alfredvc/ccairgap/commit/b9e62f7e7a4a6251ada6d0aa389b2c7a535162c6))
* **clipboard:** host-side clipboardBridge module with per-platform watchers ([80ae75c](https://github.com/Alfredvc/ccairgap/commit/80ae75c7784787de902dbf9010ff158d0a0dfec8))
* **config:** add --profile for named config files ([6741296](https://github.com/Alfredvc/ccairgap/commit/674129685df166129a6383eb662e38ce6ede1657))
* **docker:** pre-create /run/ccairgap-clipboard bridge dir; add no-xclip invariant test ([43c2a27](https://github.com/Alfredvc/ccairgap/commit/43c2a27319918098eee27ed7cac605ea7d57edb7))
* **doctor:** report clipboard mode + install hints ([05586d0](https://github.com/Alfredvc/ccairgap/commit/05586d015d79d14204673aaeb1609782eef7d604))
* **entrypoint:** install fake wl-paste shim + runtime xclip-present warning ([c1529ce](https://github.com/Alfredvc/ccairgap/commit/c1529ced80d2d412cc18fc2a52d57c314deb22a3))
* **git:** add dirtyTree() helper for working-tree scan ([6ec8e2d](https://github.com/Alfredvc/ccairgap/commit/6ec8e2db1321860ac6b7fd9126be1e3c6f7022bb))
* **handoff:** preserve session on dirty tree or scan failure ([c617484](https://github.com/Alfredvc/ccairgap/commit/c617484047dbdb373176a388e0166ef6b8ca0be7))
* **launch:** integrate clipboard bridge setup + await cleanup in finally ([b3d5865](https://github.com/Alfredvc/ccairgap/commit/b3d5865190fd79f99b3b1512a72d45c40142f5d2))
* **list:** surface dirty counts in scanOrphans + listOrphans ([db70838](https://github.com/Alfredvc/ccairgap/commit/db708384cf38bc35354915d2d1f4ee8d3c1c5684))
* **mounts:** add clipboard-bridge MountSource kind and /run/ccairgap-clipboard reserved prefix ([e203d0c](https://github.com/Alfredvc/ccairgap/commit/e203d0c13021cba5e8f19c53af885c55da33a139))
* **recover:** refuse to run against live container; share docker-ps probe ([88edd12](https://github.com/Alfredvc/ccairgap/commit/88edd12d2761174e4a60cc2b69a3ade541adf266))
* **resume:** accept session name or UUID for --resume ([12bacf0](https://github.com/Alfredvc/ccairgap/commit/12bacf05081efdb6465e7d00ec3bbe7fc9d4719d))


### Bug Fixes

* **clipboard:** replace pngpaste with built-in osascript on macOS ([b68024f](https://github.com/Alfredvc/ccairgap/commit/b68024f2e327b0bf001337656d09d84bf6bf142c))
* **naming:** always pass ccairgap <id> to claude -n and rename hook ([d4c329b](https://github.com/Alfredvc/ccairgap/commit/d4c329b65be7fc763d359db105cbdf1090438429))

## [0.2.0](https://github.com/Alfredvc/ccairgap/compare/v0.1.0...v0.2.0) (2026-04-19)


### Features

* **cli:** add -r, --resume <session-id> flag ([081fdd8](https://github.com/Alfredvc/ccairgap/commit/081fdd8926d684d068e46a1923485c1d19f09279))
* **config:** accept 'resume' scalar key ([ca2038e](https://github.com/Alfredvc/ccairgap/commit/ca2038e86e25f07bee6a08a6642b0540cb2d7257))
* **container:** propagate host timezone via TZ env + tzdata ([afac771](https://github.com/Alfredvc/ccairgap/commit/afac771bbf5054ed2282f50859c4e681888db53d))
* **entrypoint:** add RESUME_ARGS; title hook falls back to CCAIRGAP_RESUME_ORIG_NAME ([1668216](https://github.com/Alfredvc/ccairgap/commit/16682167fce3f03978f5d61d730c1229a28f93ef))
* **image:** auto-rebuild when Dockerfile or entrypoint.sh changes ([545d7de](https://github.com/Alfredvc/ccairgap/commit/545d7de42ea496e825cd23116837b4e6109df9ef))
* **launch:** call copyInResume when --resume is passed ([571111b](https://github.com/Alfredvc/ccairgap/commit/571111b31acd65da52379284ba3882e2944743ac))
* **launch:** emit CCAIRGAP_RESUME/ORIG_NAME; set CCAIRGAP_NAME only when --name passed ([b273af7](https://github.com/Alfredvc/ccairgap/commit/b273af7278da26bf5760fa8e79ca441ca3d4fc83))
* **mounts:** collision resolver with exact-dst dedup + reserved-path guard ([8686b3b](https://github.com/Alfredvc/ccairgap/commit/8686b3bbebae44eaf9172255119b9671e46a87dc))
* **mounts:** pre-filter drops marketplaces subsumed by a --repo tree ([eab27cb](https://github.com/Alfredvc/ccairgap/commit/eab27cbdc7dbb5e7eaec647bcfd3cac85642b9d0))
* **mounts:** run collision resolver at end of buildMounts ([7019db9](https://github.com/Alfredvc/ccairgap/commit/7019db9ccaed4e2b2a2a1022fdc2534cfd5b89c2))
* **paths:** alternatesName helper for unique per-repo scratch segments ([0c48131](https://github.com/Alfredvc/ccairgap/commit/0c4813129f5e75870c3c00edd8dcc8e0d8077c68))
* **resume:** add extractLatestAgentName helper ([1d7d092](https://github.com/Alfredvc/ccairgap/commit/1d7d092aec987ce99bc55cca7784a85a7bcae4df))
* **resume:** add resolveResumeSource + copyResumeTranscript ([7bc3cfe](https://github.com/Alfredvc/ccairgap/commit/7bc3cfefc1aac4df31b6a74b01897184f02b881d))
* **sessionId:** add readable session id generator ([047ebcb](https://github.com/Alfredvc/ccairgap/commit/047ebcb4ae69ee3ba06374e4b0c192710ba9f132))
* support .config/ccairgap/config.yaml as fallback config location ([08048ae](https://github.com/Alfredvc/ccairgap/commit/08048aef7285ca71eecf6febc91752f2d03f790b))


### Bug Fixes

* **artifacts:** include pre-filtered marketplaces in overlap check; wire pre-filter into launch ([d1dcf37](https://github.com/Alfredvc/ccairgap/commit/d1dcf375d3c8237610ef39acd344577c3d60d640))
* **launch:** use realpath in repo/ro overlap guard; preserve ENOENT UX ([7c84dda](https://github.com/Alfredvc/ccairgap/commit/7c84dda86e0aca5e873cd8d531b6c4854f312206))
* **mounts:** disambiguate per-repo scratch paths with alternatesName (clone dir + alternates mount + policy dir + manifest + handoff/orphans) ([9d15656](https://github.com/Alfredvc/ccairgap/commit/9d156560f8e80af8d0812107f1f3c3e29578fca9))
* **mounts:** mount ~/.claude/plugins at host-abs path ([9030a33](https://github.com/Alfredvc/ccairgap/commit/9030a33aac75da8461bb3ce79553d2ad8e1ed6d3))


### Performance

* **resume:** chunked reverse-read for extractLatestAgentName ([1564279](https://github.com/Alfredvc/ccairgap/commit/1564279a99bb4557ae4862290db58c9e5d944fed))


### Refactors

* **entrypoint:** use 'ccairgap <id>' as initial claude -n label ([7f262f7](https://github.com/Alfredvc/ccairgap/commit/7f262f74af219a9ed31b054f79651f8818d57ef7))
* **mounts:** tag every Mount with a MountSource for collision diagnostics ([2407719](https://github.com/Alfredvc/ccairgap/commit/2407719d85a297af366434482b9a003710563263))
* **resume:** drop unused workspaceHostPath from CopyResumeTranscriptArgs ([9dce585](https://github.com/Alfredvc/ccairgap/commit/9dce585c82c3083affa233c9e886713771803079))
* **resume:** use path.basename instead of lastIndexOf slice ([82c69d5](https://github.com/Alfredvc/ccairgap/commit/82c69d5f178a2cae86193aa25bbd2d8644dfa0dd))
* unify session identifier as <prefix>-<4hex> ([45ba7cf](https://github.com/Alfredvc/ccairgap/commit/45ba7cf8e302315aee56e31ef8c41b36bb1be5cb))
