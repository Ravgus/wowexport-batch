# wowexport-batch

Export World of Warcraft creatures and models with [wow.export](https://github.com/Kruithne/wow.export) from a JSON job file instead of clicking through the UI.

wow.export is a GUI application, and its remote control protocol (RCP) was removed in 0.2.2. This tool drives an unmodified wow.export install so that a script, a build step or an AI agent can export the same assets the same way every time.

**Tested only with wow.export 0.2.19 (Linux build).** The tool depends on wow.export internals, so any other version may break it.

## How it works

1. `run_job.py` builds an app folder in `~/.cache/wowexport-batch/app`: symlinks to your installed wow.export files, a copy of the launcher and its own `package.json`, which tells NW.js to inject `runner.js` into the page (`inject_js_end`).
2. It starts that copy with its own profile (`--user-data-dir`) and auto-update turned off. Your wow.export install, its settings and its cache stay as they were.
3. `runner.js` waits for the app to load, opens the local game install and exports each entry of the job through the same tab methods the Export button calls. It records which file each asset produced, writes a result file and quits.

`runner.js` only performs these fixed steps. Nothing from the job file is run as code.

## Requirements

- Linux. Tested with the wow.export 0.2.19 Linux build.
- wow.export unpacked in `~/.local/share/wow.export`, or set `WOWEXPORT_HOME` to its folder.
- Python 3.8 or newer. The standard library is enough.
- A local WoW install. If you have opened it in wow.export before, it is found from wow.export's recent installs; otherwise pass `--install`.
- A desktop session. A wow.export window appears while the job runs and closes when it is done. Leave it alone until then.

The first run downloads wow.export's listfile and other caches into the tool's own profile, so it takes longer than later runs.

## Usage

```sh
git clone https://github.com/Ravgus/wowexport-batch.git
python3 wowexport-batch/run_job.py job.json
python3 wowexport-batch/run_job.py job.json --export-dir ~/exports --install "/path/to/World of Warcraft"
```

| Option | Default |
| --- | --- |
| `--export-dir DIR` | `export_dir` from the job (relative to the job file), else the export directory of your regular wow.export |
| `--install PATH` | `WOW_INSTALL`, else `install` from the job, else your wow.export's most recent install of this product |
| `--product NAME` | `product` from the job, else `wow` (other values: `wow_classic`, `wow_classic_era`, ...) |
| `--manifest FILE` | `exported.json` in the export directory |
| `--timeout SEC` | 1800 for the whole job |

The exit code is 0 when every entry was exported, 1 otherwise.

## Job file

```json
{
  "export_dir": "../assets",
  "creatures": [
    {"id": 26499, "name": "Arthas, Prince of Lordaeron"}
  ],
  "models": [
    {"path": "item/objectcomponents/weapon/sword_2h_frostmourne_d_01.m2", "format": "OBJ"},
    {"path": "world/wmo/dungeon/md_mountaincave/md_corruptcave01.wmo", "format": "OBJ"},
    {"fdid": 145790, "display": 31954, "format": "OBJ", "name": "hammer_2h_pvpalliance_a_01"}
  ]
}
```

Job fields:

| Field | Meaning |
| --- | --- |
| `creatures` | Creatures from the Creatures tab, by NPC ID. |
| `models` | Models from the Models tab: M2 and WMO files. |
| `export_dir` | Where to export, relative to the job file. |
| `install`, `product` | The game install and the CASC product to open. |
| `creature_format` | Default format for creatures: `GLTF` (default), `GLB`, `OBJ` or `STL`. |
| `log_geosets` | `true` writes each creature's geosets to the log, to see which ones wow.export turned on. |

Entry fields:

| Field | Meaning |
| --- | --- |
| `id` | Creature: the NPC ID, as on Wowhead (`/npc=26499`). Required. |
| `path` or `fdid` | Model: the game path from the listfile, or the FileDataID. One of them is required. |
| `format` | `GLTF` (default), `GLB`, `OBJ` or `STL`. |
| `display` | Model: an ItemDisplayInfo ID. Selects the skin whose label ends with `(<display>)`, for item models with several textures. |
| `groups` | WMO: indices of the groups to export (their order in the root WMO), for example a few rooms of a whole city. Default: all groups. Doodads are not filtered by group: every doodad of the turned-on sets is exported. |

Any other keys are ignored, so the job file can also carry your own notes and import settings.

The tool sets these wow.export options in its own profile: animations are exported, M2 and WMO metadata JSON is written, existing files are overwritten and paths use forward slashes. For a WMO, all doodad sets are turned on, and all groups unless `groups` is given.

## Output

- Exported files land in the export directory in wow.export's usual layout: creatures under `creatures/`, models under their game paths.
- The manifest (`exported.json`) maps each asset to the file it produced and the game build, for example `"creature:26499"`, `"model:item/objectcomponents/weapon/sword_2h_frostmourne_d_01.m2"` or `"model:fdid:145790"`. Later runs update it in place, so an import script can find files without guessing their names.
- Each run keeps `job.json`, `log.txt` and `result.json` in `~/.cache/wowexport-batch/runs/<date-time>/`.

## Finding IDs and paths

- NPC IDs: Wowhead URLs, or the `Creature` table on [wago.tools](https://wago.tools/db2).
- Model paths: the listfile wow.export caches in `~/.config/wow.export/Default/casc/listfile/` (read it with `strings`), or the file browser on wago.tools.
- Item models and their display IDs: the `ItemModifiedAppearance`, `ItemAppearance`, `ItemDisplayInfo` and `ModelFileData` tables on wago.tools.

## Limitations

- wow.export has no automation API, so `runner.js` relies on its internals (`core.view`, `modules.tab_*` and their methods). A wow.export update can break it; the script warns when the installed version is not one it was tested with.
- Local installs only. wow.export's CDN mode is not supported yet.
- Linux only: the launcher name, config paths and the cleanup of leftover processes through `/proc` are Linux-specific.
- Not headless: wow.export needs a display.
- What wow.export leaves out of a creature export is left out here too. For example, NPC weapons are not part of the creature; export them as item models.

## License

MIT, see [LICENSE](LICENSE). This project is not affiliated with Blizzard Entertainment or with the wow.export authors. World of Warcraft and its assets belong to Blizzard Entertainment.
