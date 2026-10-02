// HISTORICAL ONLY: OSM/Nominatim/Overpass are not active V1 providers.
// Historical OSM compatibility is covered by unit tests, not production discovery.
console.error('OSM production verification is retired. Use npm run verify:geoapify:production instead.');
process.exitCode = 1;
