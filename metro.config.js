const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add wav files to asset extensions for alarm sound
config.resolver.assetExts.push('wav');

module.exports = config;
