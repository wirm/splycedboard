/**
 * Builds a Savant Blueprint lighting-table plist from the LEAP inventory, so the
 * lighting data table doesn't have to be typed in by hand.
 *
 * Row layout mirrors a real Blueprint export. Ketra/Rania zones use Entity "DMX"
 * with state "CurrentColor" so Savant shows the color controls. Keypad buttons, when
 * asked for, are "Keypad Button" rows as Blueprint writes them: press and release, and the
 * button's LED as its state (IsCurrentLEDOn_<device>_<LED>, which profile 1.15 feeds).
 */
const { toPlist } = require('../../core/plist');

const EXPORT_TYPES = new Set(['dimmer', 'switch', 'fan', 'ketra', 'rania']);

function rowMeta(type) {
  switch (type) {
    case 'ketra': return { entity: 'DMX', stateName: 'CurrentColor', typeLabel: 'RGBW', command: 'DimmerSet', group: 'Dimmer' };
    case 'rania': return { entity: 'DMX', stateName: 'CurrentColor', typeLabel: 'CCT', command: 'DimmerSet', group: 'Dimmer' };
    case 'fan': return { entity: 'Fan', stateName: 'DimmerLevel', typeLabel: 'Fan', command: 'FanSet', group: 'Fan' };
    case 'switch': return { entity: 'Switch', stateName: 'DimmerLevel', typeLabel: 'W', command: 'DimmerSet', group: 'Dimmer' };
    default: return { entity: 'Dimmer', stateName: 'DimmerLevel', typeLabel: 'W', command: 'DimmerSet', group: 'Dimmer' };
  }
}

// Which columns Blueprint treats as user-modified ("UMF") on import.
const UMF = {
  Address1: true,
  Command: false,
  'Command Type': false,
  Controller: true,
  'Controller Zone': true,
  DelayTime: false,
  DimmerLevel: false,
  Entity: true,
  FadeTime: false,
  IsSceneable: false,
  Label: true,
  LightsAreOn: false,
  RoomLightsControl: false,
  SavantAppGrouping: false,
  State1: false,
  State2: false,
  Type: true,
  'UI Type': false,
  WholeHouseLightsControl: false,
};

function stateRef(component, zoneId, stateName) {
  return {
    RPMStateName: `${component}.Lighting_controller.${stateName}_${zoneId}`,
    RPMStateType: 'RPMComponentBasedStateName',
    component,
    identifiers: [{ description: '', name: 'DeviceID', value: String(zoneId) }],
    logicalComponent: 'Lighting_controller',
    stateName,
  };
}

/** A load the lighting table covers (shades and thermostats have tables of their own). */
const isLighting = (zone) => EXPORT_TYPES.has(zone.type);

function lightingRow(zone, index, component, savantZones) {
  const meta = rowMeta(zone.type);
  const state = stateRef(component, zone.id, meta.stateName);
  return {
    Address1: String(zone.id),
    Address2: '',
    Address3: '',
    Address4: '',
    Address5: '',
    Address6: '',
    BLEGroupId: '',
    BLENetworkKey: '',
    BLENodeId: '',
    'Button Label': zone.name,
    Command: meta.command,
    'Command Type': 'Push Command',
    Controller: component,
    'Controller Zone': zone.areaName,
    DelayTime: '0',
    DimmerLevel: '',
    Enabled: 'YES',
    Entity: meta.entity,
    FadeTime: '2',
    Identifier: String(index),
    IsSceneable: true,
    Label: zone.name,
    LightsAreOn: true,
    'Logical Component': 'Lighting_controller',
    RoomLightsControl: 'Active',
    'Savant Keypad': '',
    // One light can be in several Savant zones; none chosen: the Lutron area's name.
    'Savant Zone': Object.fromEntries((savantZones.length ? savantZones : [zone.areaName]).map((z) => [z, true])),
    SavantAppGrouping: meta.group,
    ServiceID: 'SVC_ENV_LIGHTING',
    State1: state,
    State2: state,
    Technology: '',
    'Toggle Label': '',
    Type: meta.typeLabel,
    'UI Type': 'Slider',
    UMF,
    WholeHouseLightsControl: 'Active',
    hasCompiled: true,
    maxKelvinTemp: '',
    minKelvinTemp: '',
    sendReleaseAfterHold: true,
    shouldDefaultRow: true,
  };
}

// A Keypad Button row's column flags: a light's, without Type
const { Type: _type, ...KEYPAD_UMF } = UMF;

/**
 * One keypad button, as Blueprint writes a Keypad Button row: the row presses, its five
 * children are the rest of the entity's toggle (release, OSD press and hold).
 * @param k  { label, deviceId, number, ledId|null, areaName, savantZones: [] }
 */
function keypadRow(k, index, component) {
  const id = String(index);
  const led = k.ledId != null ? String(k.ledId) : '';
  const zones = Object.fromEntries((k.savantZones.length ? k.savantZones : [k.areaName]).map((z) => [z, true]));
  const address = {
    Address1: String(k.deviceId),
    Address2: String(k.number),
    Address3: led,
    Address4: '',
    Address5: '',
    Address6: '',
  };
  const child = (command, commandType) => ({
    ...address,
    'Button Label': '',
    Command: command,
    'Command Type': commandType,
    Controller: component,
    'Controller Zone': k.areaName,
    Enabled: 'YES',
    Entity: 'Keypad Button',
    Identifier: id,
    Label: '',
    LightsAreOn: false,
    'Savant Keypad': '',
    'Savant Zone': zones,
    Technology: '',
    Type: '',
    'UI Type': 'Toggle',
    shouldDefaultRow: true,
  });
  return {
    ...address,
    BLEGroupId: '',
    BLENetworkKey: '',
    BLENodeId: '',
    'Button Label': k.label,
    Command: 'ButtonPress',
    'Command Type': 'Push Command',
    Controller: component,
    'Controller Zone': k.areaName,
    DelayTime: '',
    DimmerLevel: '',
    Enabled: 'YES',
    Entity: 'Keypad Button',
    FadeTime: '',
    Identifier: id,
    IsSceneable: false,
    Label: k.label,
    LightsAreOn: false,
    'Logical Component': 'Lighting_controller',
    RoomLightsControl: 'No',
    'Savant Keypad': '',
    'Savant Zone': zones,
    SavantAppGrouping: 'Scene',
    ServiceID: 'SVC_ENV_LIGHTING',
    State1: {
      RPMStateName: `${component}.Lighting_controller.IsCurrentLEDOn_${k.deviceId}_${led || '0'}`,
      RPMStateType: 'RPMComponentBasedStateName',
      component,
      identifiers: [
        { description: '', name: 'DeviceID', value: String(k.deviceId) },
        { description: '', name: 'LEDNumber', value: led || '0' },
      ],
      logicalComponent: 'Lighting_controller',
      stateName: 'IsCurrentLEDOn',
    },
    State2: {},
    Technology: '',
    'Toggle Label': k.label,
    Type: '',
    'UI Type': 'Toggle',
    UITypeChild: [
      child('ButtonPress', 'Toggle Command'),
      child('ButtonRelease', 'Release Command'),
      child('ButtonRelease', 'Toggle Release Command'),
      child('ButtonPressAndRelease', 'OSD Push Command'),
      child('ButtonPressAndRelease', 'OSD Hold Command'),
    ],
    UMF: KEYPAD_UMF,
    WholeHouseLightsControl: 'No',
    hasCompiled: false,
    maxKelvinTemp: '',
    minKelvinTemp: '',
    sendReleaseAfterHold: false,
    shouldDefaultRow: true,
  };
}

/**
 * @param zones          iterable of controller zone objects
 * @param component      Blueprint component name
 * @param zonesFor       zone → the Savant zones it's in (rooms.js); none: the Lutron area's name
 * @param keypadButtons  keypad buttons to add as Keypad Button rows (see keypadRow), after the lights
 */
function buildLightingPlist(zones, component, { zonesFor = () => [], keypadButtons = [] } = {}) {
  const rows = Array.from(zones)
    .filter(isLighting)
    .map((zone, i) => lightingRow(zone, i, component, zonesFor(zone)));
  rows.push(...keypadButtons.map((k, i) => keypadRow(k, rows.length + i, component)));
  return toPlist({ Lighting: rows });
}

module.exports = { buildLightingPlist, isLighting };
