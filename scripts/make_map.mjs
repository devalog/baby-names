// Builds docs/data/us-states.json: one SVG path per state, from the us-atlas package
// (US Census boundaries, already projected with Alaska and Hawaii as insets).
// Only needs re-running if the map outlines should change.
//
//   npm install us-atlas@3.0.1 topojson-client@3.1.0 d3-geo@3.1.1
//   node scripts/make_map.mjs docs/data/us-states.json

import fs from "node:fs";
import { feature, mesh } from "topojson-client";
import { geoPath } from "d3-geo";
const topo = JSON.parse(fs.readFileSync("node_modules/us-atlas/states-albers-10m.json"));
const FIPS = {"01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY"};
const path = geoPath().digits(1);
const states = {};
for (const f of feature(topo, topo.objects.states).features) {
  const ab = FIPS[f.id];
  if (ab) states[ab] = path(f);
}
const out = { width: 975, height: 610, states };
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log(Object.keys(states).length, "states");
