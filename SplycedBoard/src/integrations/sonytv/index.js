/**
 * Sony TV tool: finds BRAVIA TVs, checks the Pre-Shared Key set on each, and works them like
 * a remote. The shared part is core/tv/tool.js; this is Sony's driver.
 */
const { TvTool } = require('../../core/tv/tool');
const driver = require('./driver');

module.exports = { create: (ctx) => new TvTool(ctx, driver) };
