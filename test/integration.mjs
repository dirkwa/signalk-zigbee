// Run by the Signal K plugin CI (npm run test:integration) once it has
// started a server with this plugin enabled and an empty configuration.
// The CI itself only checks that the plugin is listed, which Signal K also
// does for a plugin whose start() threw, so ask the plugin's own API that
// start() ran and the configuration is valid. The container start-up that
// follows needs a container runtime and is not covered here.
const url = `${process.env.SIGNALK_URL ?? "http://localhost:3000"}/plugins/signalk-zigbee/api/status`;
const ATTEMPTS = 10;

let status;
for (let attempt = 1; status === undefined; attempt++) {
  try {
    const res = await fetch(url);
    if (res.ok) status = await res.json();
    else if (attempt === ATTEMPTS) fail(`${url} answered ${res.status}`);
  } catch (err) {
    if (attempt === ATTEMPTS) fail(`${url} failed: ${err}`);
  }
  if (status === undefined) await new Promise((r) => setTimeout(r, 1000));
}

if (status.running !== true) fail("the plugin did not start");
if (status.problems.length > 0) fail(`problems: ${status.problems.join(" ")}`);
console.log(`signalk-zigbee started: ${JSON.stringify(status)}`);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}
