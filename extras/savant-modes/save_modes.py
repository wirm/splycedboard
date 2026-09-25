#define imports
import sys
import subprocess
import json
import traceback
import datetime

# --- config ---------------------------------------------------------------
sclipath = "/Users/Shared/Savant/Applications/RacePointMedia/sclibridge"
storefile = "/Users/Shared/savant_modes.json"
logfile = "/Users/Shared/savant_modes_debug.log"

# State Center variable names. Key = the name in the JSON file,
# value = the full state path to read from Savant.
states = {
    "vacation_mode_status":       "userDefined.vacation_mode_status",
    "vacation_mode_guest_status": "userDefined.vacation_mode_guest_status",
    "timer_mode_status":          "userDefined.timer_mode_status",
    "holiday_mode_status":        "userDefined.holiday_mode_status",
}
# --------------------------------------------------------------------------


def log(msg):
    line = "%s  %s\n" % (datetime.datetime.now().isoformat(), msg)
    with open(logfile, "a") as f:
        f.write(line)


def read_state(path):
    # capture stderr too so we can see sclibridge complaints in the log
    result = subprocess.run(
        [sclipath, "readstate", path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    out = result.stdout.decode("utf-8", "replace").strip()
    err = result.stderr.decode("utf-8", "replace").strip()
    log("readstate %s -> rc=%s out=%r err=%r" % (path, result.returncode, out, err))
    return out


try:
    log("=== save_modes start (python %s) ===" % sys.version.split()[0])

    values = {}
    for name, path in states.items():
        values[name] = read_state(path)

    with open(storefile, "w") as f:
        json.dump(values, f, indent=2)

    log("wrote %s -> %s" % (storefile, json.dumps(values)))
    print(json.dumps(values))

except Exception:
    log("FAILED:\n" + traceback.format_exc())
    raise
