#define imports
import sys
import os
import subprocess
import json

# --- config ---------------------------------------------------------------
sclipath = "/Users/Shared/Savant/Applications/RacePointMedia/sclibridge"
storefile = "/Users/Shared/savant_modes.json"

# State Center variable names. Key = the name in the JSON file,
# value = the full state path to write back into Savant.
states = {
    "vacation_mode_status":       "userDefined.vacation_mode_status",
    "vacation_mode_guest_status": "userDefined.vacation_mode_guest_status",
    "timer_mode_status":          "userDefined.timer_mode_status",
    "holiday_mode_status":        "userDefined.holiday_mode_status",
}
# --------------------------------------------------------------------------

# If there's no saved file yet (e.g. very first boot), there's nothing to do.
if not os.path.exists(storefile):
    print("no store file at " + storefile + " - nothing to restore")
    sys.exit(0)

with open(storefile, "r") as f:
    values = json.load(f)

# Push each saved value back into the Savant State Center
for name, path in states.items():
    if name not in values:
        continue
    value = str(values[name])
    subprocess.Popen([sclipath, "writestate", path, value], stdout=subprocess.PIPE)

print(json.dumps(values))
