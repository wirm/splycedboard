/**
 * LG TV tool: finds LG TVs, checks the keycode each one shows on its IP Control Setup
 * screen, and works them like a remote. The shared part is core/tv/tool.js; this is LG's driver.
 */
const { TvTool } = require('../../core/tv/tool');
const driver = require('./driver');

module.exports = { create: (ctx) => new TvTool(ctx, driver) };
