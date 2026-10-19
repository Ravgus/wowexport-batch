"""Export World of Warcraft assets through wow.export from a JSON job file, without clicking.

Starts a separate wow.export instance with its own profile and its own app folder, into which
runner.js is injected, and runs the job: creatures by NPC ID and models by game path or
FileDataID. Your regular wow.export and its settings are left untouched.

usage: python3 run_job.py job.json [--export-dir DIR] [--install PATH] [--product wow]
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WX_HOME = Path(os.environ.get("WOWEXPORT_HOME", Path.home() / ".local/share/wow.export"))
WX_CONFIG = Path.home() / ".config/wow.export/Default/config.json"
STATE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "wowexport-batch"
TESTED_VERSIONS = {"0.2.19"}


def read_wx_config():
    """Config of your regular wow.export: recent installs and export directory."""
    return json.loads(WX_CONFIG.read_text()) if WX_CONFIG.exists() else {}


def find_install(args, job):
    path = args.install or os.environ.get("WOW_INSTALL") or job.get("install")
    if path:
        return path
    for entry in read_wx_config().get("recentLocal", []):
        if entry.get("product") == args.product:
            return entry["path"]
    sys.exit(f"no WoW install for product '{args.product}': pass --install or set WOW_INSTALL")


def find_export_dir(args, job, job_path):
    if args.export_dir:
        return Path(args.export_dir).expanduser().resolve()
    if job.get("export_dir"):
        return (job_path.parent / Path(job["export_dir"]).expanduser()).resolve()
    if read_wx_config().get("exportDirectory"):
        return Path(read_wx_config()["exportDirectory"])
    sys.exit("no export directory: pass --export-dir or set export_dir in the job")


def check_job(job):
    errors = [f"creature without id: {c}" for c in job.get("creatures", []) if "id" not in c]
    errors += [f"model without path or fdid: {m}" for m in job.get("models", []) if not (m.get("path") or m.get("fdid"))]
    if not job.get("creatures") and not job.get("models"):
        errors.append("the job has no creatures and no models")
    if errors:
        sys.exit("bad job file:\n" + "\n".join(errors))


def replace_link(link, target):
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(target)


def build_app():
    """App folder: links to wow.export's files plus our own package.json that injects runner.js.

    NW.js reads package.json from the folder of the launched executable, so the executable
    (a small launcher, about 240 KB) is copied rather than linked: a link would resolve to the original.
    """
    if not (WX_HOME / "wow.export").exists():
        sys.exit(f"wow.export not found in {WX_HOME}: set WOWEXPORT_HOME to its folder")
    app = STATE / "app"
    app.mkdir(parents=True, exist_ok=True)
    for src in WX_HOME.iterdir():
        if src.name == "wow.export":
            dst = app / src.name
            if dst.is_symlink() or dst.exists():
                dst.unlink()
            shutil.copy2(src, dst)
        elif src.name != "package.json":
            replace_link(app / src.name, src)
    replace_link(app / "runner.js", HERE / "runner.js")
    manifest = json.loads((WX_HOME / "package.json").read_text())
    if manifest.get("version") not in TESTED_VERSIONS:
        print(f"warning: tested with wow.export {', '.join(sorted(TESTED_VERSIONS))}, found {manifest.get('version')}")
    manifest["inject_js_end"] = "runner.js"
    manifest["window"]["inject_js_end"] = "runner.js"
    (app / "package.json").write_text(json.dumps(manifest, indent=1))
    return app


def record_assets(result, manifest_path):
    """Manifest: which file each asset produced and from which game build."""
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for asset in result.get("assets", []):
        manifest[asset["key"]] = {"file": asset["file"], "build": result["build"], "exported": time.strftime("%Y-%m-%d %H:%M")}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True))


def kill_leftovers():
    """NW.js sometimes leaves helper processes of this profile behind after it exits."""
    marker = str(STATE / "profile").encode()
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        try:
            if marker in (proc_dir / "cmdline").read_bytes():
                os.kill(int(proc_dir.name), signal.SIGTERM)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("job", help="job file: JSON with creatures and models lists")
    parser.add_argument("--export-dir", help="where to export (default: export_dir from the job, "
                        "relative to the job file, else your wow.export's export directory)")
    parser.add_argument("--install", help="WoW install folder (default: WOW_INSTALL, else the most recent "
                        "install of this product in your wow.export)")
    parser.add_argument("--product", help="CASC product: wow, wow_classic, wow_classic_era, ... (default: wow)")
    parser.add_argument("--manifest", help="asset manifest to update (default: exported.json in the export directory)")
    parser.add_argument("--timeout", type=int, default=1800, help="seconds for the whole job")
    args = parser.parse_args()

    job_path = Path(args.job).resolve()
    job = json.loads(job_path.read_text())
    check_job(job)
    args.product = args.product or job.get("product", "wow")
    export_dir = find_export_dir(args, job, job_path)
    export_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(args.manifest).resolve() if args.manifest else export_dir / "exported.json"

    run_dir = STATE / "runs" / time.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True)
    full_job = {
        "install": {"path": find_install(args, job), "product": args.product},
        "export_dir": str(export_dir),
        "creatures": job.get("creatures", []),
        "models": job.get("models", []),
        "creature_format": job.get("creature_format", "GLTF"),
        "log_geosets": job.get("log_geosets", False),
    }
    job_file = run_dir / "job.json"
    job_file.write_text(json.dumps(full_job, ensure_ascii=False, indent=1))
    log_file, result_file = run_dir / "log.txt", run_dir / "result.json"

    env = dict(os.environ, WX_JOB=str(job_file), WX_LOG=str(log_file), WX_RESULT=str(result_file))
    cmd = [str(build_app() / "wow.export"), f"--user-data-dir={STATE / 'profile'}", "--disable-auto-update"]
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        proc.wait(timeout=args.timeout)
    except subprocess.TimeoutExpired:
        proc.terminate()
        print(f"timed out after {args.timeout} s, wow.export stopped")
    kill_leftovers()

    if log_file.exists():
        print(log_file.read_text(), end="")
    if not result_file.exists():
        sys.exit(f"no result, see {run_dir}")
    result = json.loads(result_file.read_text())
    record_assets(result, manifest_path)
    print(f"build: {result['build']}, assets: {len(result['assets'])}, files: {len(result['exported'])}, errors: {len(result['errors'])}")
    for error in result["errors"]:
        print("error:", error)
    print(f"details: {run_dir}")
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
