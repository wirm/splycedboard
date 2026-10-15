/**
 * ITv2 command codes and value tables, named as Savant's own DSC PowerSeries Neo profile names
 * them (it drives the same protocol through Savant's ITv2 coprocessor plugin).
 */
const COMMANDS = {
  // Session
  0x0501: 'CommandError', // NACK: the packet itself was wrong
  0x0502: 'CommandResponse', // the result of a command: 00 = success
  0x0600: 'Poll',
  0x060a: 'OpenSession',
  0x060b: 'EndSession',
  0x060c: 'BufferSize',
  0x060d: 'SoftwareVersion',
  0x060e: 'RequestAccess',
  0x0613: 'SystemCapabilities',
  0x0614: 'PanelStatus',
  0x0615: 'DeviceEnrollment',
  0x0622: 'LongPacket',
  0x0623: 'MultipleMessages',
  // Notifications the panel pushes
  0x0110: 'PanelEventBuffer',
  0x0210: 'ZoneStatus', // "lifestyle" zone open/close, in real time
  0x0220: 'TimeStamp',
  0x0221: 'Temperature',
  0x0230: 'ExitDelay',
  0x0231: 'EntryDelay',
  0x0232: 'ArmingDisarming',
  0x0233: 'ArmingPreAlert',
  0x0234: 'EnrolmentStatus',
  0x0236: 'AccessCodeLength',
  0x0238: 'QuickExit',
  0x0239: 'ReadyStatus',
  0x023a: 'SystemTest',
  0x023b: 'AudibleBell',
  0x023c: 'AlarmMemory',
  0x023f: 'TroubleStatus',
  0x0240: 'BypassStatus',
  0x0241: 'BusyStatus',
  0x0244: 'CommandOutput',
  // Configuration
  0x0701: 'ExitConfigurationMode',
  0x0702: 'ProgrammingLeadInOut',
  0x0704: 'EnterConfigurationMode',
  0x0735: 'BypassedZones',
  0x074a: 'ZoneBypassWrite',
  0x0770: 'ZoneAssignment',
  0x0771: 'Labels',
  0x0772: 'PartitionAssignment',
  // Requests (0800 + the code of what's asked for) and their answers
  0x0800: 'Request',
  0x0810: 'GlobalStatus',
  0x0811: 'ZoneStatusBlock',
  0x0812: 'PartitionStatus',
  0x0813: 'ZoneBypassStatus',
  0x0820: 'SingleZoneBypass',
  0x0840: 'ZoneAlarm',
  // Actions
  0x0900: 'Arm',
  0x0901: 'Disarm',
  0x0902: 'CommandOutputActivate',
  0x0908: 'KeypadAlarm',
  0x0f00: 'VirtualKeypadSetup',
  0x0f02: 'KeypadDisplay',
};

const name = (code) => COMMANDS[code] || `0x${code.toString(16).padStart(4, '0').toUpperCase()}`;

// 0502: what came of a command (DSC's own list, from DLS5)
const RESPONSE = {
  0x00: 'Success',
  0x01: 'Cannot exit configuration',
  0x02: 'Invalid programming type',
  0x03: 'Unsupported module',
  0x04: 'Invalid signal type',
  0x10: 'Not in the right programming mode',
  0x11: 'Invalid access code',
  0x12: 'Access code required',
  0x13: 'Partition busy',
  0x14: 'Invalid partition',
  0x17: 'Function not available',
  0x18: 'Internal error',
  0x19: 'Command timed out',
  0x1a: 'No troubles of that type',
  0x1b: 'No alarms found',
  0x1c: 'Invalid device module',
  0x1d: 'Invalid trouble type',
};

// 0501: why the communicator refused the packet itself
const NACK = {
  0x00: 'Unknown error',
  0x01: 'Command length wrong',
  0x02: 'Invalid command',
  0x03: 'Wrong sequence number',
  0x04: 'Panel not responding',
  0x05: 'Invalid pass-through command',
  0x06: 'Invalid destination',
  0x07: 'Invalid session',
  0x08: 'Insufficient buffer',
  0x09: 'Locked out',
  0x0a: 'Unsupported sub-command',
  0x0b: 'Power-up shunt',
  0x10: 'Invalid programming mode',
  0x11: 'Invalid access code',
  0x12: 'Access code required',
  0x13: 'System busy',
  0x14: 'Invalid partition',
  0x17: 'Function not available',
  0x18: 'Internal error',
  0x19: 'Command timed out',
  0x1c: 'Invalid device module',
  0x1d: 'Invalid trouble type',
  0x1e: 'Programming tag or access code required',
  0x1f: 'Programming tag required',
};

// 0900 arm modes
const ARM_MODE = { stay: 0x01, away: 0x02, night: 0x04, 'stay-instant': 0x07 };

// 0232: a partition's arming state
const ARMING = {
  0x00: { mode: 'disarmed', text: 'Disarmed' },
  0x01: { mode: 'stay', text: 'Armed Stay' },
  0x02: { mode: 'away', text: 'Armed Away' },
  0x03: { mode: 'armed', text: 'Armed, no entry delay' },
  0x04: { mode: 'night', text: 'Armed Night' },
  0x05: { mode: 'armed', text: 'Quick Arm' },
  0x06: { mode: 'armed', text: 'User Arm' },
  0x07: { mode: 'stay', text: 'Armed Stay, no entry delay' },
  0x08: { mode: 'away', text: 'Armed Away, no entry delay' },
  0x09: { mode: 'night', text: 'Armed Night, no entry delay' },
  0x0b: { mode: 'stay', text: 'Armed Stay (global)' },
  0x0c: { mode: 'away', text: 'Armed Away (global)' },
  0x0d: { mode: 'armed', text: 'Custom arming mode A' },
  0x0e: { mode: 'armed', text: 'Custom arming mode B' },
  0x0f: { mode: 'armed', text: 'Custom arming mode C' },
  0x10: { mode: 'armed', text: 'Custom arming mode D' },
  0x11: { mode: 'stay', text: 'Armed Instant Stay' },
  0x12: { mode: 'armed', text: 'Arming (hidden)' },
};

// 0232: how it was armed or disarmed
const ARM_METHOD = { 0x00: 'unknown', 0x01: 'access code', 0x02: 'function key' };

// 0239: whether a partition can be armed
const READY = {
  0x00: { ready: null, text: 'Unknown' },
  0x01: { ready: true, text: 'Ready' },
  0x02: { ready: true, text: 'Ready to force arm' },
  0x03: { ready: false, text: 'Not ready' },
};

// 0231: entry delay
const ENTRY_DELAY = { 0x00: 'stopped', 0x01: 'running', 0x02: 'urgent, alarms in memory', 0x03: 'urgent' };

// 0840: what kind of alarm a zone is in
const ALARM_TYPE = {
  0x00: 'Unknown',
  0x01: 'Burglary',
  0x02: '24-hour supervisory',
  0x03: 'Fire',
  0x04: 'Fire supervisory',
  0x05: 'CO',
  0x06: 'Gas',
  0x07: 'High temperature',
  0x08: 'Low temperature',
  0x09: 'Medical',
  0x0a: 'Panic',
  0x0b: 'Waterflow',
  0x0c: 'Water',
};

module.exports = { COMMANDS, name, RESPONSE, NACK, ARM_MODE, ARMING, ARM_METHOD, READY, ENTRY_DELAY, ALARM_TYPE };
