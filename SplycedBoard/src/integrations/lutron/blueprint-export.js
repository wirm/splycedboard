/**
 * Builds a Savant Blueprint lighting-table plist from the LEAP inventory, so the
 * lighting data table doesn't have to be typed in by hand.
 *
 * Row layout mirrors a real Blueprint export. Ketra/Rania zones use Entity "DMX"
 * with state "CurrentColor" so Savant shows the color controls.
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

/**
 * @param zones      iterable of controller zone objects
 * @param component  Blueprint component name
 * @param zonesFor   zone → the Savant zones it's in (rooms.js); none: the Lutron area's name
 */
function buildLightingPlist(zones, component, { zonesFor = () => [] } = {}) {
  const rows = Array.from(zones)
    .filter(isLighting)
    .map((zone, i) => lightingRow(zone, i, component, zonesFor(zone)));
  return toPlist({ Lighting: rows });
}

module.exports = { buildLightingPlist, isLighting };
