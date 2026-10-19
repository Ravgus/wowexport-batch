// Automatic exports from wow.export. Injected via inject_js_end only into the separate instance
// that run_job.py starts. Reads the job from WX_JOB, performs fixed steps (open the install, export
// creatures by ID and models by path), writes a log and a result, then quits.
// Nothing from the job file is ever run as code.
(function () {
	// a mark in wow.export's own runtime.log: shows that the script was injected and got a job
	const trace = (msg) => {
		const timer = setInterval(() => {
			if (window.log?.write) {
				window.log.write('[runner] %s', msg);
				clearInterval(timer);
			}
		}, 200);
	};
	trace('injected, job = ' + (typeof process !== 'undefined' ? process.env.WX_JOB : 'no process object'));

	const job_path = process.env.WX_JOB;
	if (!job_path || window.__wx_runner)
		return;
	window.__wx_runner = true;

	const fs = require('fs');
	const path = require('path');
	const log_path = process.env.WX_LOG;
	const result_path = process.env.WX_RESULT;

	const log = (...parts) => {
		const line = new Date().toISOString().slice(11, 19) + ' ' + parts.join(' ') + '\n';
		if (log_path)
			fs.appendFileSync(log_path, line);
	};

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	const wait_for = async (what, check, timeout_ms = 120000, step_ms = 250) => {
		const start = Date.now();
		while (Date.now() - start < timeout_ms) {
			try {
				if (check())
					return;
			} catch (e) {
				// the app is not ready yet
			}
			await sleep(step_ms);
		}
		throw new Error('timeout waiting for ' + what);
	};

	// `this` for tab methods: $core, $modules, the component's data and its methods
	const make_ctx = (module_def) => {
		const ctx = { $core: core, $modules: modules };
		if (typeof module_def.data === 'function')
			Object.assign(ctx, module_def.data.call(ctx));
		for (const [name, fn] of Object.entries(module_def.methods || {}))
			ctx[name] = fn.bind(ctx);
		return ctx;
	};

	const files_since = (dir, since_ms, out = []) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory())
				files_since(full, since_ms, out);
			else if (fs.statSync(full).mtimeMs >= since_ms)
				out.push(full);
		}
		return out;
	};

	const wait_preview = async (what) => {
		await sleep(500);
		await wait_for(what, () => !core.view.isBusy, 180000);
		await sleep(1500);
	};

	// Character-model NPCs get their baked textures as "data-<type>.png" next to the glTF, the same names for
	// every creature, so the next export overwrites them. Give them the creature's name and fix the glTF.
	const own_textures = (gltf_path) => {
		if (!gltf_path.endsWith('.gltf'))
			return;
		const dir = path.dirname(gltf_path);
		const stem = path.basename(gltf_path, '.gltf');
		const gltf = JSON.parse(fs.readFileSync(gltf_path, 'utf8'));
		let renamed = 0;
		for (const image of gltf.images || []) {
			if (!image.uri || !/^data-\d+\.png$/.test(image.uri))
				continue;
			const own = stem + '_' + image.uri;
			fs.renameSync(path.join(dir, image.uri), path.join(dir, own));
			image.uri = own;
			renamed++;
		}
		if (renamed)
			fs.writeFileSync(gltf_path, JSON.stringify(gltf, null, '\t'));
	};

	const export_creatures = async (job, result) => {
		modules.tab_creatures.setActive();
		await wait_for('creature list', () => core.view.listfileCreatures?.length > 0 && !core.view.isBusy, 600000, 500);
		const ctx = make_ctx(modules.tab_creatures);
		for (const creature of job.creatures) {
			core.view.config.exportCreatureFormat = creature.format || job.creature_format || 'GLTF';
			const entry = core.view.listfileCreatures.find((e) => e.endsWith('[' + creature.id + ']'));
			if (!entry) {
				result.errors.push('creature not found: ' + creature.id);
				log('creature not found:', creature.id);
				continue;
			}
			core.view.selectionCreatures = [entry];
			await wait_preview('creature preview ' + creature.id);
			// wow.export 0.2.19 applies an NPC's equipment geosets (robe skirts, sleeves, boots) only when its
			// equipment list changes: on the first preview it skips them because is_character_model is still false.
			// Replacing the list with a copy runs that refresh, and the export takes the preview's geosets.
			if (Array.isArray(core.view.creatureViewerEquipment) && core.view.creatureViewerEquipment.length) {
				core.view.creatureViewerEquipment = core.view.creatureViewerEquipment.map((item) => Object.assign({}, item));
				await sleep(3000);
				await wait_preview('creature equipment ' + creature.id);
			}
			if (job.log_geosets)
				log('geosets', creature.id, JSON.stringify((core.view.creatureViewerGeosets || []).map((g) => g.id + (g.checked ? '+' : '-'))));
			if (core.view.selectionCreatures.length === 0) {
				result.errors.push('selection was reset: ' + entry);
				log('selection was reset:', entry);
				continue;
			}
			const before = Date.now() - 1000;
			await ctx.export_creatures();
			const main = files_since(path.join(job.export_dir, 'creatures'), before)
				.filter((f) => /\.(gltf|glb|obj|stl)$/i.test(f));
			if (main.length !== 1) {
				result.errors.push('expected one model file for creature ' + creature.id + ', got ' + main.length);
				log('unexpected output for creature', creature.id, main.length);
				continue;
			}
			own_textures(main[0]);
			result.assets.push({ key: 'creature:' + creature.id, entry, file: path.relative(job.export_dir, main[0]) });
			log('exported creature:', entry);
		}
	};

	// build labels on the source screen start with the product title (wow.export 0.2.19 constants.PRODUCTS)
	const PRODUCT_TITLES = {
		wow: 'World of Warcraft', wowt: 'PTR: World of Warcraft', wowxptr: 'PTR 2: World of Warcraft',
		wow_beta: 'Beta: World of Warcraft', wow_classic: 'World of Warcraft Classic',
		wow_classic_ptr: 'PTR: World of Warcraft Classic', wow_classic_era: 'World of Warcraft Classic Era'
	};

	// Blizzard's CDN instead of a local install: for builds you don't have installed, such as the PTR
	const open_cdn = async (region_tag, product) => {
		const ctx = make_ctx(modules.source_select);
		await wait_for('CDN regions', () => core.view.cdnRegions?.some((r) => r.tag === region_tag), 60000, 250);
		core.view.lockCDNRegion = true;          // otherwise the region ping race may switch it
		core.view.selectedCDNRegion = core.view.cdnRegions.find((r) => r.tag === region_tag);
		await ctx.click_source_remote();
		await wait_for('CDN builds', () => core.view.availableRemoteBuilds?.length > 0, 120000, 500);
		const title = PRODUCT_TITLES[product];
		// "PTR: World of Warcraft 12.1.7.70424" or "... (EU) 12.1.7.70424": the title, then the version
		const escaped = (title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp('^' + escaped + ' (\\(\\w+\\) )?\\d');
		const build = core.view.availableRemoteBuilds.find((b) => title && pattern.test(String(b.label)));
		if (!build)
			throw new Error('no CDN build for ' + product + ': ' + core.view.availableRemoteBuilds.map((b) => b.label).join(', '));
		log('CDN build:', build.label);
		await ctx.load_install(build.buildIndex);
	};

	const export_models = async (job, result) => {
		modules.tab_models.setActive();
		await wait_for('models tab', () => core.view.modelViewerContext && core.view.listfileModels?.length > 0 && !core.view.isBusy, 600000, 500);
		const ctx = make_ctx(modules.tab_models);
		for (const model of job.models) {
			// a model is given by path or FileDataID; the selection must match the list entry
			// exactly (it may read "path [id]"), otherwise the list resets it
			const wanted = model.path ? model.path.toLowerCase() : null;
			const entry = core.view.listfileModels.find((e) => {
				const name = String(e).toLowerCase();
				if (model.fdid)
					return name.endsWith('[' + model.fdid + ']');
				return name === wanted || name.startsWith(wanted + ' ');
			});
			// the same model with another skin is another asset: "fdid:143332#53296"
			const label = (model.path || 'fdid:' + model.fdid) + (model.display ? '#' + model.display : '');
			if (!entry) {
				result.errors.push('model not in listfile: ' + label);
				log('model not in listfile:', label);
				continue;
			}
			const game_path = String(entry).replace(/ \[\d+\]$/, '');
			core.view.config.exportModelFormat = model.format || 'GLTF';
			core.view.selectionModels = [entry];
			await wait_preview('model preview ' + model.path);
			if (game_path.endsWith('.wmo') && Array.isArray(core.view.modelViewerWMOSets)) {
				for (const set of core.view.modelViewerWMOSets)
					set.checked = true;
				// only the listed groups (indices in the root WMO), e.g. a few rooms of a whole city
				if (Array.isArray(model.groups) && Array.isArray(core.view.modelViewerWMOGroups)) {
					for (const group of core.view.modelViewerWMOGroups)
						group.checked = model.groups.includes(group.groupIndex);
					const found = core.view.modelViewerWMOGroups.filter((g) => g.checked).length;
					if (found !== model.groups.length) {
						result.errors.push('wmo groups: found ' + found + ' of ' + model.groups.length + ' for ' + label);
						log('wmo groups missing:', label, JSON.stringify(model.groups));
						continue;
					}
				}
			}
			if (model.display) {
				// the item skin with the wanted appearance: its label ends with "(<ItemDisplayInfo ID>)"
				const skin = (core.view.modelViewerSkins || []).find((s) => String(s.label).endsWith('(' + model.display + ')'));
				if (!skin) {
					result.errors.push('skin ' + model.display + ' not found for ' + label);
					log('skin not found:', model.display, 'skins:', JSON.stringify((core.view.modelViewerSkins || []).map((s) => s.label)));
					continue;
				}
				core.view.modelViewerSkinsSelection = [skin];
				await wait_preview('skin ' + model.display);
			}
			if (core.view.selectionModels.length === 0) {
				result.errors.push('selection was reset: ' + model.path);
				log('selection was reset:', model.path);
				continue;
			}
			const before = Date.now() - 1000;
			await ctx.export_model();
			// the model file: with a skin selected, wow.export appends the skin name ("model_skin.obj")
			const ext = { GLTF: '.gltf', GLB: '.glb', OBJ: '.obj', STL: '.stl' }[core.view.config.exportModelFormat];
			const stem = path.basename(game_path).replace(/\.[^.]+$/, '');
			const dir = path.join(job.export_dir, path.dirname(game_path));
			const outputs = fs.existsSync(dir) ? files_since(dir, before).filter((f) =>
				path.dirname(f) === dir && f.endsWith(ext) && path.basename(f).startsWith(stem)) : [];
			if (outputs.length !== 1) {
				result.errors.push('expected one output file for ' + label + ', got ' + outputs.length);
				log('unexpected output for', label, outputs.length);
				continue;
			}
			const file = path.relative(job.export_dir, outputs[0]);
			result.assets.push({ key: 'model:' + label, entry, file });
			log('exported model:', entry, core.view.config.exportModelFormat);
		}
	};

	const run = async () => {
		const job = JSON.parse(fs.readFileSync(job_path, 'utf8'));
		const result = { ok: false, build: null, assets: [], exported: [], errors: [] };
		const started = Date.now();
		try {
			await wait_for('app init', () => core.view.config && modules.source_select && core.view.activeModule, 120000);
			log('app ready');

			Object.assign(core.view.config, {
				exportDirectory: job.export_dir,
				pathFormat: 'posix',
				allowCacheCollection: false,
				overwriteFiles: true,
				modelsExportAnimations: true,
				creatureAutoPreview: true,
				modelsAutoPreview: true,
				exportM2Meta: true,
				exportWMOMeta: true
			});

			if (job.install.cdn)
				await open_cdn(job.install.cdn, job.install.product);
			else
				await make_ctx(modules.source_select).open_local_install(job.install.path, job.install.product);
			await wait_for('CASC load', () => core.view.installType === modules.InstallType.CASC && core.view.casc, 1800000, 500);
			result.build = core.view.casc.build?.Version ?? core.view.casc.build?.VersionsName ?? null;   // local / CDN build
			log('install loaded:', job.install.cdn ? 'CDN ' + job.install.cdn + ' ' + job.install.product : job.install.path, result.build);

			if (job.creatures?.length)
				await export_creatures(job, result);
			if (job.models?.length)
				await export_models(job, result);

			result.exported = files_since(job.export_dir, started - 2000).map((f) => path.relative(job.export_dir, f)).sort();
			result.ok = result.errors.length === 0;
		} catch (e) {
			result.errors.push(String((e && e.stack) || e));
			log('error:', (e && e.stack) || e);
		}
		if (result_path)
			fs.writeFileSync(result_path, JSON.stringify(result, null, 1));
		log('done, ok =', result.ok);
		setTimeout(() => nw.App.quit(), 500);
	};

	run();
})();
