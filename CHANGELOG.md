# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.6.0](https://github.com/Alfredvc/ccairgap/compare/v0.5.2...v0.6.0) (2026-05-13)


### Features

* add `ccairgap attach <id>` to spawn second claude in running container ([b5fb432](https://github.com/Alfredvc/ccairgap/commit/b5fb43255d47a42688ad69025eea1b3aa6799130))
* **agent:** add selected agent config surface ([3e81335](https://github.com/Alfredvc/ccairgap/commit/3e8133577a4ef410ca39cd092f6105c92c755c08))
* **auth:** propagate host-driven `/login` account swap to running container ([001d4f6](https://github.com/Alfredvc/ccairgap/commit/001d4f69e899b87721c44e7dd733b67e02d63dc4))
* **cli:** wire user-wide layer + --no-user-config ([d30897e](https://github.com/Alfredvc/ccairgap/commit/d30897e18071bf95ddca13885804d7cc6ba82ed0))
* **codex:** materialize sanitized codex state ([7f07f71](https://github.com/Alfredvc/ccairgap/commit/7f07f71226ad90f7aa9c0592741cba9b27ac8cb7))
* **codex:** validate selected codex args ([75657f5](https://github.com/Alfredvc/ccairgap/commit/75657f5fcdd141ded196d2629531fc515df48b38))
* **config:** add resolveUserWideConfigPaths ([4d0183c](https://github.com/Alfredvc/ccairgap/commit/4d0183c28843c20152081f4220abe13c31bed89f))
* **config:** dotfiles-repo realpath collision check ([0e95432](https://github.com/Alfredvc/ccairgap/commit/0e954327d9bc882117ec46c48a85b0f814196b9e))
* **config:** layered merge with provenance tracking ([9ae188e](https://github.com/Alfredvc/ccairgap/commit/9ae188e043dbec72fe67cc3ba5084b060304ed19))
* **docker-run-arg:** add integration safe-flag allowlist ([5f324b5](https://github.com/Alfredvc/ccairgap/commit/5f324b521f25a6b550e6b1da2bc264a85b4f6088))
* **doctor:** user-wide config subsection ([e3476d9](https://github.com/Alfredvc/ccairgap/commit/e3476d9934de5699817192056d4b1e4f71a2d2db))
* **entrypoint:** user-wide overlay before project; emit CCAIRGAP_USER_DIR ([806c1ac](https://github.com/Alfredvc/ccairgap/commit/806c1ac2ea48c6308dcf0119cbbe5011f4f56ca4))
* **handoff:** copy codex rollout sessions safely ([58a222f](https://github.com/Alfredvc/ccairgap/commit/58a222f200ccb3db6243904d2d9e14c4957a2bee))
* **init:** add --user flag for user-wide scaffolding ([fd501df](https://github.com/Alfredvc/ccairgap/commit/fd501df225626f88f9952945ad379c7f7d4d23da))
* **init:** scaffold extension Dockerfile ([21784a2](https://github.com/Alfredvc/ccairgap/commit/21784a2ae2557029271240d5ff2537c25514787a))
* **inspect:** expose layered config + provenance ([705ea59](https://github.com/Alfredvc/ccairgap/commit/705ea59ffc1f6091d4578ea9e3da87712d0ffae9))
* **inspect:** honor --no-user-config and --bare ([a2936cc](https://github.com/Alfredvc/ccairgap/commit/a2936cc4616d8efb685ced0d090e96fcd21d8a8e))
* **inspect:** render object values as K=V per line in RESOLVED CONFIG ([94a8734](https://github.com/Alfredvc/ccairgap/commit/94a87347ce1fd812567b633ae91f9957013a24cf))
* **integration:** allow bare `-e KEY` env passthrough in drop-ins ([ebf43ba](https://github.com/Alfredvc/ccairgap/commit/ebf43ba73bf8add6ec7b1479b9da2bc8cdbd77e0))
* **launch:** enable selected codex runtime ([d7d8777](https://github.com/Alfredvc/ccairgap/commit/d7d877754f448a3e1f96e11f673975cf97141138))
* **mounts:** add codex state mount inputs ([38daf2a](https://github.com/Alfredvc/ccairgap/commit/38daf2a97f06106db39773a50360327c684b9672))
* **mounts:** emit /ccairgap-user-dir mount ([9408bae](https://github.com/Alfredvc/ccairgap/commit/9408baeab36aecbfec7924110001332faedb5339))
* **mounts:** reserve /ccairgap-user-dir + MountSource arm ([a999df5](https://github.com/Alfredvc/ccairgap/commit/a999df5e8e3fb6a7e0f015b8217ec07c1a087449))
* **runtime:** add dual-agent image contract ([adaf86a](https://github.com/Alfredvc/ccairgap/commit/adaf86a12c14216a7f55f90ef491174113344afc))
* **subcommands:** make agent subcommands codex-aware ([dc1fcad](https://github.com/Alfredvc/ccairgap/commit/dc1fcad47af5ceddf66e4699b7733035dbe11591))
* **user-config:** add resolveUserWideDir helper ([411f3dd](https://github.com/Alfredvc/ccairgap/commit/411f3dd6ee804fe6f003617f9723f46d140be963))
* **user-config:** integration drop-in loader with key + flag allowlists ([61f0715](https://github.com/Alfredvc/ccairgap/commit/61f071594f669a5c875d8eb50cdb5d34aa005a87))
* **user-config:** load + resolve user-wide config.yaml ([ada8a24](https://github.com/Alfredvc/ccairgap/commit/ada8a2491c93cb88aba573109411f0edef34c46b))


### Bug Fixes

* **auth:** keep runtime watcher mirroring host across throws and host-side writes ([6800d79](https://github.com/Alfredvc/ccairgap/commit/6800d795c521f144ed23c61055caa7fd20931724))
* **codex:** copy installed skill trees verbatim, drop dot-files ([9e6d47d](https://github.com/Alfredvc/ccairgap/commit/9e6d47dcbe73b021a2a461183a14b2ef9b7f82a6))
* **codex:** drop plan-tier auth gate ([8b55f1c](https://github.com/Alfredvc/ccairgap/commit/8b55f1caee791333825aabdb6bc56d84287c931a))
* **codex:** materialize guidance symlinks ([0c27d1e](https://github.com/Alfredvc/ccairgap/commit/0c27d1efa0f36abf2c67a9f3e44f206068c46d2f))
* **config:** collision detection works under --no-user-config ([a710e02](https://github.com/Alfredvc/ccairgap/commit/a710e02b142433a2a89bd85714deb76bb3e8250c))
* **doctor:** split user-wide policy bypass from overlay files ([65d9bae](https://github.com/Alfredvc/ccairgap/commit/65d9baea297007b8c67aba20e012f954f824bab1))
* **entrypoint:** match overlay skills rsync to main rsync (.venv excludes + exit-23 tolerance) ([7a9dfe5](https://github.com/Alfredvc/ccairgap/commit/7a9dfe59cd93ee3feee484f1db623c17009aed20))
* **inspect:** look up hooks.enable/mcp.enable provenance under dotted key ([595b068](https://github.com/Alfredvc/ccairgap/commit/595b0680c069a6e454479b831b71191b4e82ebd2))
* **launch:** pre-materialize absolute symlinks under ~/.claude/ host-side ([854f29f](https://github.com/Alfredvc/ccairgap/commit/854f29fa067722700ee4bb5cfcdc60e6efce8fd6))
* **release:** close final review blockers ([1a1ba17](https://github.com/Alfredvc/ccairgap/commit/1a1ba17e5c28ba1b46dbfd392c0ca65369680e5c))
* **resume:** encode cwd like Claude Code's sanitizePath ([582c0ff](https://github.com/Alfredvc/ccairgap/commit/582c0ffa33c0e1a5bcdeb31ee7c96ca5a45cdb8f))


### Refactors

* **cli:** drop duplicate userWideDir existence gate ([ec356fc](https://github.com/Alfredvc/ccairgap/commit/ec356fc92f7d7e432bb7ca8d69d150ff91500bc9))
* **handoff:** one log line per main session id, skip sidecars ([673afa7](https://github.com/Alfredvc/ccairgap/commit/673afa704c7b0aa235c14f5b3b680a10972d02b4))
* **mounts:** one kind per line in MountSource union ([4dd68c4](https://github.com/Alfredvc/ccairgap/commit/4dd68c43aaf93ee91ca9f7ef977bc73ce83da0ea))

## [0.5.2](https://github.com/Alfredvc/ccairgap/compare/v0.5.1...v0.5.2) (2026-05-01)


### Bug Fixes

* **entrypoint:** tolerate host Python venvs in ~/.claude rsync ([a2e591a](https://github.com/Alfredvc/ccairgap/commit/a2e591a8e6bb61c1a08d1e531c015ac95ef74a12))

## [0.5.1](https://github.com/Alfredvc/ccairgap/compare/v0.5.0...v0.5.1) (2026-05-01)


### ⚠ BREAKING CHANGES

* recover refuses on dirty session; --force discards

### Features

* **handoff:** log each transcript file copied ([5a0c4dc](https://github.com/Alfredvc/ccairgap/commit/5a0c4dc2775942cb4c25add822aab61bf7f6570b))
* recover refuses on dirty session; --force discards ([ee17ab9](https://github.com/Alfredvc/ccairgap/commit/ee17ab968c123925beaa813295a850f8dcc72ac9))

## [0.5.0](https://github.com/Alfredvc/ccairgap/compare/v0.4.3...v0.5.0) (2026-04-30)


### ⚠ BREAKING CHANGES

* publish default image to GHCR; UID-portable runtime via --user

### Features

* publish default image to GHCR; UID-portable runtime via --user ([2f64450](https://github.com/Alfredvc/ccairgap/commit/2f64450ba0f44c9dec81f984f443b9503585f3a4))

## [0.4.3](https://github.com/Alfredvc/ccairgap/compare/v0.4.2...v0.4.3) (2026-04-27)


### Features

* **auth:** add atomic creds writer for session creds file ([9a7d36d](https://github.com/Alfredvc/ccairgap/commit/9a7d36dcbf65a90aa528f6584e96630308e14122))
* **auth:** runtime auth-refresh watcher with mtime ownership check ([2bc3a1b](https://github.com/Alfredvc/ccairgap/commit/2bc3a1b4305817582babe65333380ae16a9e0326))
* **auth:** symlink container creds at /host-claude-creds-dir; route auth warnings via title hook ([67d2145](https://github.com/Alfredvc/ccairgap/commit/67d214519d8c68a2f3a48fc27e70841155d87314))
* **auth:** wire runtime auth-refresh watcher; switch creds mount to RW directory + auth-warnings RO mount ([87ecbf9](https://github.com/Alfredvc/ccairgap/commit/87ecbf9de3e178f0b8fcd398bd4a55899b6375f8))
* **doctor:** per-session auth-refresh status rows ([af1da2c](https://github.com/Alfredvc/ccairgap/commit/af1da2c4c19a277b065d8d2c16734a9bdd050ee0))


### Bug Fixes

* **doctor:** remove dead WARN flag from auth-refresh checks ([48b4972](https://github.com/Alfredvc/ccairgap/commit/48b4972d774fef281ef9e8fd7959b5f8ed57ce93))
* **e2e:** resolve smoke.sh toplevel before cd into tmp repo ([c0276d1](https://github.com/Alfredvc/ccairgap/commit/c0276d13f5d2cc97c17d23c8f78fb63b64c51c94))


### Refactors

* **auth:** use writeSessionCreds; export readHostCredsJson for runtime watcher ([e7cb927](https://github.com/Alfredvc/ccairgap/commit/e7cb9274a0fe4b092e4801adacfcf1b4805619b4))

## [0.4.2](https://github.com/Alfredvc/ccairgap/compare/v0.4.1...v0.4.2) (2026-04-21)


### Features

* **cli:** add shell tab-completion via @pnpm/tabtab ([2c049e5](https://github.com/Alfredvc/ccairgap/commit/2c049e5070dfbb158e9b9f21afc1e39f0c7b1fda))
* **entrypoint:** advise model on bypass-immune paths ([336ba24](https://github.com/Alfredvc/ccairgap/commit/336ba246161bc78de769e83fe154e34c6cc5d868))


### Bug Fixes

* **completion:** allow `--` tail on completion-server callback ([3fcf63e](https://github.com/Alfredvc/ccairgap/commit/3fcf63ecd851cae22a67da6b04fe1bdbfc80c33b))
* **completion:** only uninstall shells where ccairgap is installed ([70377a7](https://github.com/Alfredvc/ccairgap/commit/70377a7e4fc9fdc223d0b3e6c7a2a7ef41b946b7))

## [0.4.1](https://github.com/Alfredvc/ccairgap/compare/v0.4.0...v0.4.1) (2026-04-20)


### Bug Fixes

* **docker:** preserve HOST_GID when UID collides with base image user ([d7dac94](https://github.com/Alfredvc/ccairgap/commit/d7dac94e669d0f57adc4a316dceed47fd237d64d))
* **overlay:** allowlist project .claude/ subpaths to skip parked junk ([9193287](https://github.com/Alfredvc/ccairgap/commit/919328765f1ec45547f4784f44a373a1c689557a))

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
