# Savant mode save / restore

Two standalone Python 3 scripts, separate from the SplycedBoard service. They save and
restore Savant State Center variables with `sclibridge`, so modes survive a host restart.

| Script | Does |
|---|---|
| `save_modes.py` | Reads the variables below and writes them to `/Users/Shared/savant_modes.json` (debug log: `/Users/Shared/savant_modes_debug.log`) |
| `restore_modes.py` | Writes the saved values back into Savant, if the file exists |

Variables: `userDefined.vacation_mode_status`, `userDefined.vacation_mode_guest_status`,
`userDefined.timer_mode_status`, `userDefined.holiday_mode_status`. Edit the `states` table
at the top of both scripts to change the list.

Typical use: run `save_modes.py` from a Savant workflow whenever a mode changes, and
`restore_modes.py` from a startup workflow.
