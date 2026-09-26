/**
 * Samsung TV tool: finds Samsung TVs, gets each one's AccessToken, and works them like a
 * remote. The shared part is core/tv/tool.js; this is Samsung's driver.
 */
const { TvTool } = require('../../core/tv/tool');
const driver = require('./driver');

module.exports = { create: (ctx) => new TvTool(ctx, driver) };
